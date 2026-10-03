import axios from 'axios';
import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { DATA_SOURCES, DataSourceProfile, FALLBACK_DATA_SOURCE, SourceRole } from '../../config/sources';
import { logger } from '../../logger';
import { cachedFetch, CachedFetchOptions, FetchedBuffer } from '../cachedFetch';
import { http, HttpStatusError } from '../http';
import { yumeFetchPlan, SourceFetchPlan } from './yume';

/**
 * 上游数据源回退链: 主源(DATA_SOURCE) → 备用源(BACKUP_SOURCE) → bdon.moe 兜底。
 *
 * - 规范化 URL 固定为 bdon 布局(客户端照旧拼 URL), 每次尝试翻译成对应源的取数方式
 * - 任何失败(含 404 / 200 但非 JSON)都切下一个源; 全部失败时: 最后一个是 4xx 就原样抛出
 *   (保留「空表 / 未被追踪」等语义), 否则抛 UpstreamCrashedError
 * - 磁盘缓存键按源统一前缀 `{源名}/{原键}` —— 源间不串数据
 * - 未匹配任何角色的 URL(外部图床等)保持原样: 单次恒等尝试 + 原键
 */

export class UpstreamCrashedError extends Error {
    constructor(message = '错误: 上游崩溃（主源/备用源/兜底源均不可用）', options?: ErrorOptions) {
        super(message, options);
        this.name = 'UpstreamCrashedError';
    }
}

export interface ChainAttempt {
    source: string;
    url: string;
    /** 缓存键(无键的直连请求为 undefined) */
    key?: string;
    transform?: (data: Buffer) => Buffer;
}

export interface ChainOptions {
    kernel?: (url: string, options: CachedFetchOptions) => Promise<FetchedBuffer | undefined>;
    requestFn?: (url: string, headers: Record<string, string> | undefined, retries: number) => Promise<unknown>;
    sources?: Readonly<Record<string, DataSourceProfile>>;
    chain?: readonly string[];
    log?: (msg: string) => void;
}

export interface ChainedFetcher {
    buffer(url: string, options: CachedFetchOptions): Promise<FetchedBuffer>;
    json<T>(url: string, options: CachedFetchOptions): Promise<T>;
    image(url: string, cacheKey: string): Promise<Buffer | undefined>;
    request<T>(url: string, options?: { headers?: Record<string, string>; retries?: number }): Promise<T>;
    /** 该 URL 的尝试序列(测试/诊断用) */
    attempts(url: string, key?: string): ChainAttempt[];
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 按规范化 URL 判定数据角色; 不认识的 URL(外部图床等)返回 undefined */
export function detectRole(url: string): SourceRole | undefined {
    if (url.startsWith(`${config.metaBase}/`)) return 'meta';
    if (url.startsWith(`${config.assetBase}/`)) {
        return url.slice(config.assetBase.length + 1).startsWith('chart-site/') ? 'chartSite' : 'asset';
    }
    if (url.startsWith(`${config.gameApiBase}/`)) return 'gameApi';
    if (url.startsWith(`${config.moenotesSiteBase}/`)) return 'site';
    if (config.musicDataUrl && url === config.musicDataUrl) return 'musicData';
    return undefined;
}

function planFor(url: string, role: SourceRole, profile: DataSourceProfile): SourceFetchPlan | undefined {
    switch (profile.layout) {
        case 'bdon':
            return { url };                                       // 规范化布局 = 恒等
        case 'yume':
            return yumeFetchPlan(url, role, profile);
        default:
            return undefined;
    }
}

/**
 * 构造按数据源链回退的取数器(buffer/json/image/request 四个入口)。
 * @param options 依赖注入点: 默认用真实 kernel(cachedFetch/http)与 config 的链; 测试可注入假 kernel
 */
export function createChainedFetcher(options: ChainOptions = {}): ChainedFetcher {
    const kernel = options.kernel ?? cachedFetch;
    const sources = options.sources ?? DATA_SOURCES;
    const chain = options.chain ?? config.sourceChain;
    const log = options.log ?? ((m: string) => logger('sourceChainWarn', m));
    const requestFn = options.requestFn ?? ((url: string, headers: Record<string, string> | undefined, retries: number) =>
        http.request<unknown>(url, { method: 'GET', ...(headers ? { headers } : {}) }, retries));

    function attempts(url: string, key?: string): ChainAttempt[] {
        const role = detectRole(url);
        if (!role) {
            // 无角色(外部图床等): 保持现状 —— 单次恒等尝试 + 原键
            return [{ source: FALLBACK_DATA_SOURCE, url, key }];
        }
        const out: ChainAttempt[] = [];
        for (const name of chain) {
            const profile = sources[name];
            if (!profile || !profile.roles.includes(role)) continue;   // 未声明该角色 → 跳过
            const plan = planFor(url, role, profile);
            if (!plan) continue;                                        // 无法翻译 → 跳过
            out.push({ source: name, url: plan.url, key: key === undefined ? undefined : `${name}/${key}`, transform: plan.transform });
        }
        return out;
    }

    function statusOf(e: unknown): number | undefined {
        if (axios.isAxiosError(e)) return e.response?.status;
        if (e instanceof HttpStatusError) return e.status;
        return undefined;
    }

    function failureToThrow(last: unknown, role: SourceRole | undefined): never {
        const status = statusOf(last);
        if (status !== undefined && status >= 400 && status < 500) throw last;   // 4xx 原样: 空表/未被追踪等语义
        logger('upstreamError', `all sources failed${role ? ` for ${role}` : ''}, last: ${msgOf(last)}`);
        throw new UpstreamCrashedError(undefined, { cause: last });
    }

    return {
        attempts,

        async buffer(url, opts) {
            let last: unknown;
            for (const a of attempts(url, opts.key)) {
                try {
                    const res = await kernel(a.url, { ...opts, key: a.key as string });
                    if (!res) throw new Error(`fetch failed: ${a.url}`);
                    return a.transform ? { ...res, data: a.transform(res.data) } : res;
                } catch (e) {
                    last = e;
                    log(`${a.source} failed for ${a.url}: ${msgOf(e)}; trying next`);
                }
            }
            return failureToThrow(last, detectRole(url));
        },

        async json<T>(url: string, opts: CachedFetchOptions): Promise<T> {
            let last: unknown;
            for (const a of attempts(url, opts.key)) {
                try {
                    const res = await kernel(a.url, { ...opts, key: a.key as string });
                    if (!res) throw new Error(`fetch failed: ${a.url}`);
                    const data = a.transform ? a.transform(res.data) : res.data;
                    // 解析放在尝试循环内: 200 但非 JSON(如 SPA 回退页)也算失败, 继续下一个源
                    return JSON.parse(data.toString('utf8')) as T;
                } catch (e) {
                    last = e;
                    log(`${a.source} failed for ${a.url}: ${msgOf(e)}; trying next`);
                }
            }
            return failureToThrow(last, detectRole(url));
        },

        async image(url, cacheKey) {
            for (const a of attempts(url, cacheKey)) {
                try {
                    const res = await kernel(a.url, { key: a.key as string, ttlS: ttl.imageTtlS, allowStale: true });
                    if (res) return res.data;
                } catch {
                    // 图片取不到不算错误, 尝试下一个源
                }
            }
            return undefined;                                          // 与 assets.imageBuffer 契约一致: 绝不抛
        },

        async request<T>(url: string, opts?: { headers?: Record<string, string>; retries?: number }): Promise<T> {
            let last: unknown;
            for (const a of attempts(url)) {
                try {
                    return (await requestFn(a.url, opts?.headers, opts?.retries ?? config.httpRetries)) as T;
                } catch (e) {
                    last = e;
                    log(`${a.source} failed for ${a.url}: ${msgOf(e)}; trying next`);
                }
            }
            return failureToThrow(last, detectRole(url));
        }
    };
}

const defaultFetcher = createChainedFetcher();

/** 链式缓存取数(原始字节): 任一源失败切下一个; 全败按 4xx 原样/上游崩溃抛出 */
export const chainFetchBuffer = defaultFetcher.buffer;
/** 链式缓存取数(JSON): 解析失败也触发回退 */
export const chainFetchJSON = defaultFetcher.json;
/** 链式取图: 全败返回 undefined, 绝不抛(与 imageBuffer 契约一致) */
export const chainImageBuffer = defaultFetcher.image;
/** 链式直连 GET(不走磁盘缓存): 失败回退 */
export const chainRequestJSON = defaultFetcher.request;
