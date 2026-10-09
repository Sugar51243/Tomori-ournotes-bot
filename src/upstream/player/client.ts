import axios from 'axios';
import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { logger } from '../../logger';
import { http } from '../http';
import { chainRequestJSONWithOrigin } from '../sources/chain';
import { UpstreamCrashedError } from '../sources/chain';
import type { ChainFailure } from '../sources/chain';
import { Server } from '../../features/types/Server';
import { PlayerProfile, PlayerNotFoundError, PlayerUnavailableError, PlayerSource } from '../../features/types/Player';

/**
 * 玩家档案客户端。
 *
 * 数据源自动选择: 配了 MOENOTES_API_BASE + MOENOTES_API_KEY 就走向自建网关(能查任意玩家),
 * 否则走**站点公开接口** —— 该路径已并入数据源回退链(角色 site): 默认的 bdon.moe 站点只对
 * 「在站点添加并验证了游戏账号、且个人主页已公开」的账号有数据(其余 404), 链上的备用源
 * (haneoka.org, 能查任意日服玩家)会接着顶替。
 *
 * 结果按 PLAYER_TTL_S 缓存在**内存**里(不落盘: 网关那条路径带 Authorization)。
 */

interface CacheEntry { at: number; value: PlayerProfile }

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PlayerProfile>>();

/** 网关是否可用 */
export function gatewayConfigured(): boolean {
    return !!config.moenotesApiBase && !!config.moenotesApiKey;
}

function str(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

/** 数字收口: 缺失值(undefined/null/空串)**不是 0** —— Number('') === 0 会把没给的字段画成 0 */
function num(v: unknown): number | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * 各来源的响应体统一做容错解析。
 * 站点路径进链后, haneoka 的响应已由翻译器(sources/haneoka.ts)换算成站点公开接口的形状,
 * 所以这里不需要分辨来源 —— 只把「实际供数的源名」带进出参。
 */
function normalize(server: Server, profileId: string, raw: unknown, fetchedAt?: number, origin?: string): PlayerProfile {
    const root = (raw ?? {}) as Record<string, unknown>;
    const profile = (root.profile ?? {}) as Record<string, unknown>;
    const brief = (root.brief ?? {}) as Record<string, unknown>;
    const favorites = (root.favorites ?? {}) as Record<string, unknown>;
    const favoriteCard = (profile.favoriteMemberCard ?? {}) as Record<string, unknown>;
    const profileCard = (profile.profileCard ?? {}) as Record<string, unknown>;
    const thumbnails = Array.isArray(profileCard.thumbnailUrl) ? profileCard.thumbnailUrl : [];

    return {
        server,
        profileId: str(profile.profileId ?? root.profileId ?? profileId) || profileId,
        name: str(profile.name),
        level: num(brief.level),
        rankExp: str(profile.rankExp) || undefined,
        totalFavorite: num(favorites.totalFavorite),
        favoriteCardId: num(favoriteCard.cardId),
        profileCardUrls: thumbnails.map(t => str(t)).filter(Boolean),
        fetchedAt: num(root.fetchedAt) ?? fetchedAt,
        origin
    };
}

async function fetchFromGateway(server: Server, profileId: string): Promise<PlayerProfile> {
    const url = `${config.moenotesApiBase}/v1/${server}/profile/${encodeURIComponent(profileId)}`;
    const data = await http.request<unknown>(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.moenotesApiKey}`, Accept: 'application/json' },
        timeout: config.httpTimeoutMs
    }, 0);
    // 网关路径不进链(带鉴权), 显示名由调用方约定为「自建网关」
    return normalize(server, profileId, data, undefined, '自建网关');
}

async function fetchFromSite(server: Server, profileId: string): Promise<PlayerProfile> {
    const url = `${config.moenotesSiteBase}/api/players/${server}/${encodeURIComponent(profileId)}`;
    // 走数据源回退链(角色 site); retries 0: 查号要快速给结果, 不重试
    const { data, origin } = await chainRequestJSONWithOrigin<unknown>(url, {
        headers: { Accept: 'application/json' },
        retries: 0
    });
    return normalize(server, profileId, data, undefined, origin);
}

/** 出错时按**实际用的数据源**给指引: 站点路径提示去绑定/公开, 网关路径提示查网关本身 */
function classifyError(e: unknown, source: PlayerSource): Error {
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        if (status === 404) {
            // 404 来自链上最后一个源; 若前面的源是硬失败(5xx/网络), 「查不到」就不是定论 ——
            // 把不可用的源点名告诉用户(如优先的 haneoka.org 挂了时, bdon 的 404 不代表账号不存在)
            const broken = chainFailuresOf(e)
                .filter(f => f.status === undefined || f.status >= 500)
                .map(f => f.source);
            return new PlayerNotFoundError(source, broken);
        }
        if (status === 401 || status === 403) {
            return new PlayerUnavailableError('玩家数据源拒绝访问(MOENOTES_API_KEY 无效?)', source);
        }
        if (status === 503) return new PlayerUnavailableError('玩家数据源上游未就绪', source);
        return new PlayerUnavailableError(`玩家数据源请求失败(${status ?? 'network'})`, source);
    }
    // 回退链上所有源都失败(非 4xx): 给统一的「暂不可用」, 不把链内部的错误文案透给用户
    if (e instanceof UpstreamCrashedError) return new PlayerUnavailableError('玩家数据源暂时都不可用(上游故障)', source);
    return new PlayerUnavailableError(e instanceof Error ? e.message : String(e), source);
}

/** 取回退链挂在错误上的失败记录(见 upstream/sources/chain.ts 的 ChainFailure) */
function chainFailuresOf(e: unknown): ChainFailure[] {
    const failures = (e as { chainFailures?: ChainFailure[] } | null)?.chainFailures;
    return Array.isArray(failures) ? failures : [];
}

/** 查询玩家档案; 未绑定/未公开/不存在 -> PlayerNotFoundError, 上游故障 -> PlayerUnavailableError */
export async function getPlayerProfile(server: Server, profileId: string): Promise<PlayerProfile> {
    const cacheKey = `${server}/${profileId}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl.playerTtlS * 1000) return hit.value;

    const pending = inflight.get(cacheKey);
    if (pending) return pending;

    const task = (async () => {
        const source = gatewayConfigured() ? 'gateway' : 'site';
        logger('player', `[${server}] fetch ${profileId} via ${source}`);
        try {
            const value = source === 'gateway'
                ? await fetchFromGateway(server, profileId)
                : await fetchFromSite(server, profileId);
            cache.set(cacheKey, { at: Date.now(), value });
            return value;
        } catch (e) {
            throw classifyError(e, source);
        }
    })().finally(() => { inflight.delete(cacheKey); });

    inflight.set(cacheKey, task);
    return task;
}
