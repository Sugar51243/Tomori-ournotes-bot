import axios from 'axios';
import { config } from '../config';
import { ttl } from '../config/ttl';
import { http } from '../upstream/http';
import { logger } from '../logger';
import { Server } from '../features/types/Server';

/**
 * 网页平台（web/，独立仓库）的客户端。
 *
 * 两个项目**以 HTTP API 交接**（bot 不直连它的库）：账号包查询与绑定码兑换都走它的
 * `/api/bot/*`（`X-Bot-Token` 鉴权；与网页的 `WEB_BOT_TOKEN` 是同一个值）。
 *
 * 隐私口径：网页那边对 bot 一律按**公开开关**（cards/items/songs 各自是否公开）返回 ——
 * 绑定本人也不例外；隐藏的类别直接 404。绑定的作用只是免输 ID + 用绑定码证明归属。
 *
 * 未配置（`WEB_PLATFORM_TOKEN` 为空）或网页不可达时：调用方按「未对接/暂不可用」降级，
 * 账号包相关的段落静默省略（查玩家仍然出上游档案图）。
 */

/** 错误分类: 供调用方给出恰当的文案（未对接 / 暂不可用 / 没有账号包 / 输入有误） */
export type WebPlatformErrorKind = 'unconfigured' | 'unavailable' | 'not_found' | 'validation';

export class WebPlatformError extends Error {
    constructor(public readonly kind: WebPlatformErrorKind, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'WebPlatformError';
    }
}

/** 网页的账号包摘要（`toSummary` 的 JSON 形状；stats 已按公开开关过滤） */
export interface WebAccountSummary {
    id: number;
    label: string;
    playerName: string;
    gameUid: string | null;
    playerId?: string;
    server: string;
    packageId: string;
    tgwCardRank: number;
    updatedAt: number;
    visible: { cards: boolean; items: boolean; songs: boolean };
    stats: {
        cards?: { members: number; supports: number; characters: number; ssr: number; sr: number; r: number };
        items?: { kinds: number; total: number };
        songs?: { total: number; fc: number; ap: number; b25: { count: number; ratingAvg: number | null; levelAvg: number | null; apCount: number; totalRating: number } };
    };
}

/** 歌曲完成状态汇总（网页侧现算；仅歌曲公开时下发） */
export interface SongStatusSummary {
    total: number;
    /** 任一难度「完成」（状态≥10）的歌数 —— 刻度为参考站的推断值 */
    lc: number;
    fc: number;
    ap: number;
    /** 分难度(easy/normal/hard/expert) 的 有记录/完成/FC/AP（按 歌曲×难度 计） */
    byDifficulty: Array<{ played: number; lc: number; fc: number; ap: number }>;
}

export type WebAccountCategory = 'cards' | 'items' | 'songs';

export interface WebAccountDetail {
    account: WebAccountSummary;
    category: WebAccountCategory;
    /** 类别明细（master id + 数值；名字/图标由调用方查 master 数据/bundle 换算） */
    data: Record<string, unknown> | null;
}

export interface BindIdentity {
    accountId: number;
    playerId: string;
    server: string;
    playerName: string;
    label: string;
}

/** 网页平台是否已对接（token 配了才算） */
export function webPlatformConfigured(): boolean {
    return !!config.webPlatformToken;
}

function ensureConfigured(): void {
    if (!webPlatformConfigured()) {
        throw new WebPlatformError('unconfigured', '未对接网页平台（配置 WEB_PLATFORM_TOKEN 后可用）');
    }
}

/** 把 axios 错误翻译成带分类的 WebPlatformError；优先用网页给的中文文案 */
function classify(e: unknown): WebPlatformError {
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        const body = e.response?.data as { error?: { message?: string } } | undefined;
        const message = body?.error?.message;
        if (status === 404) return new WebPlatformError('not_found', message ?? '网页平台没有这条数据', { cause: e });
        if (status === 400 || status === 422) return new WebPlatformError('validation', message ?? '请求参数不被网页平台接受', { cause: e });
        if (status === 401 || status === 403) {
            return new WebPlatformError('unavailable', '网页平台拒绝了 bot 令牌（请把两边配成同一个值）', { cause: e });
        }
        return new WebPlatformError('unavailable', message ?? `网页平台请求失败（${status ?? 'network'}）`, { cause: e });
    }
    return new WebPlatformError('unavailable', e instanceof Error ? e.message : String(e), { cause: e });
}

/** GET/POST 网页平台并拆统一信封 { ok, data } */
async function callWeb<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    ensureConfigured();
    try {
        const res = await http.requestFull(`${config.webPlatformBase}${path}`, {
            method: init.method ?? 'GET',
            headers: { 'X-Bot-Token': config.webPlatformToken },
            ...(init.body === undefined ? {} : { data: init.body }),
            timeout: init.timeoutMs ?? config.httpTimeoutMs
        }, 1);
        const parsed = JSON.parse(res.data.toString('utf8')) as { ok?: boolean; data?: T; error?: { message?: string } };
        if (!parsed.ok) throw new WebPlatformError('unavailable', parsed.error?.message ?? '网页平台返回了失败', undefined);
        return parsed.data as T;
    } catch (e) {
        if (e instanceof WebPlatformError) throw e;
        throw classify(e);
    }
}

// ---- 账号查询 ----

interface LookupValue { account: WebAccountSummary; songStatus?: SongStatusSummary }
/**
 * **只合并"同时在飞"的请求，不做跨命令的时间缓存**。
 *
 * 这里曾经按 60s 复用旧结果，理由是"账号包是快照、别重复问"。但这份摘要里带着
 * `visible`（公开开关）、`updatedAt`（数据更新）与 `masterVersion`（版本变动）——
 * 也就是说**它恰恰是"网页那边改了什么"的信号**，缓存它等于让改动迟到。
 * 实测踩到的样子：网页上把道具设为公开，bot 组卡照样回「该账号没有公开道具数据」。
 *
 * 所以：一次命令里问几次都走同一个 promise（下面这层单飞），跨命令一律重新读。
 * 这个接口只回摘要，很轻，多问一次的代价远小于拿旧开关做判断。
 */
const lookupInflight = new Map<string, Promise<LookupValue>>();

/** 按玩家公开 ID + 服 找账号包（bot 的查玩家/b25/组卡入口） */
export async function lookupAccount(playerId: string, server: Server): Promise<LookupValue> {
    ensureConfigured();
    const key = `${server}/${playerId}`;
    const pending = lookupInflight.get(key);
    if (pending) return pending;

    const task = callWeb<LookupValue>(`/api/bot/accounts/lookup?playerId=${encodeURIComponent(playerId)}&server=${server}`).finally(
        () => {
            lookupInflight.delete(key);
        }
    );

    lookupInflight.set(key, task);
    return task;
}

/** 类别明细（隐藏的类别网页会给 404 → not_found） */
export async function getAccountData(accountId: number, category: WebAccountCategory): Promise<WebAccountDetail> {
    return callWeb<WebAccountDetail>(`/api/bot/accounts/${accountId}/data?category=${category}`);
}

/** 兑换 bot 绑定码（一次性）→ 账号身份 */
export async function redeemBindCode(code: string): Promise<BindIdentity> {
    return callWeb<BindIdentity>('/api/bot/bind', { method: 'POST', body: { code } });
}
