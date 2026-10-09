import { diskCache } from '../db/cache';
import { http } from './http';
import { logger } from '../logger';

export interface CachedFetchOptions {
    key: string;
    ttlS: number;
    /** 网络失败时允许回退陈旧缓存 */
    allowStale?: boolean;
    /** 使用 ETag 重验证(304 时刷新 TTL) */
    revalidate?: boolean;
    /**
     * 跳过新鲜度判断, 每次都走条件请求(ETag 命中则 304, 无正文)。
     * 变更检测必须用它 —— 否则 TTL 内的轮询会一直读到同一份缓存, 永远发现不了更新。
     */
    forceRefresh?: boolean;
}

export interface FetchedBuffer {
    data: Buffer;
    /** 'hit' | 'revalidated' | 'network' | 'stale' */
    source: 'hit' | 'revalidated' | 'network' | 'stale';
    etag?: string;
    /**
     * 实际供数的数据源档案名(如 'bdon.moe' / 'haneoka.org') —— **只由回退链写入**
     * (见 sources/chain.ts), 出图据此标注「数据来源」; 不经链的直连取数没有这个字段。
     */
    origin?: string;
    /** 上游数据更新时间(ms): 链从 ETag 或数据源自己的钩子解出(见 sources/plan.ts) */
    upstreamAt?: number;
}

/**
 * 统一缓存读取包装:
 * 1. 新鲜缓存 -> hit
 * 2. 有 ETag 且允许重验证 -> If-None-Match; 304 -> touch + revalidated
 * 3. 网络获取成功 -> 写缓存 -> network
 * 4. 网络失败 + allowStale + 有陈旧缓存 -> stale
 * 单飞合并由 diskCache.singleFlight 保证。
 */
export function cachedFetch(url: string, options: CachedFetchOptions): Promise<FetchedBuffer | undefined> {
    return diskCache.singleFlight(options.key, async () => {
        const cached = await diskCache.read(options.key);
        if (!options.forceRefresh && cached && diskCache.isFresh(cached, options.ttlS)) {
            return { data: cached.data, source: 'hit' as const, etag: cached.etag };
        }
        try {
            const headers: Record<string, string> = {};
            if (cached?.etag && options.revalidate) headers['If-None-Match'] = cached.etag;
            const res = await http.requestFull(url, { headers });
            if (res.status === 304 && cached) {
                await diskCache.touch(options.key);
                return { data: cached.data, source: 'revalidated' as const, etag: cached.etag };
            }
            const etag = res.headers['etag'];
            await diskCache.write(options.key, res.data, { etag });
            return { data: res.data, source: 'network' as const, etag };
        } catch (e) {
            if (cached && options.allowStale !== false) {
                logger('cachedFetch', `network failed, serving stale cache: ${url} (${e instanceof Error ? e.message : e})`);
                return { data: cached.data, source: 'stale' as const, etag: cached.etag };
            }
            throw e;
        }
    });
}

/** 缓存取数 + JSON 解析; 取不到(undefined)或解析失败都会抛错 */
export async function cachedJSON<T>(url: string, options: CachedFetchOptions): Promise<T> {
    const res = await cachedFetch(url, options);
    if (!res) throw new Error(`fetch failed: ${url}`);
    return JSON.parse(res.data.toString('utf8')) as T;
}
