import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { http } from '../http';
import { Server } from '../../types/Server';
import { PlayerProfile, PlayerNotFoundError, PlayerUnavailableError, PlayerSource } from '../../types/Player';

/**
 * 玩家档案客户端。
 *
 * 数据源自动选择: 配了 MOENOTES_API_BASE + MOENOTES_API_KEY 就走向自建网关(能查任意玩家),
 * 否则回退站点公开接口 —— 后者只对「在站点添加并验证了游戏账号、且个人主页已公开」的账号有数据, 其余 404。
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

function num(v: unknown): number | undefined {
    const n = Number(str(v));
    return Number.isFinite(n) ? n : undefined;
}

/** 两个来源的响应体形状一致, 统一做容错解析 */
function normalize(server: Server, profileId: string, raw: unknown, fetchedAt?: number): PlayerProfile {
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
        fetchedAt: num(root.fetchedAt) ?? fetchedAt
    };
}

async function fetchFromGateway(server: Server, profileId: string): Promise<PlayerProfile> {
    const url = `${config.moenotesApiBase}/v1/${server}/profile/${encodeURIComponent(profileId)}`;
    const data = await http.request<unknown>(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.moenotesApiKey}`, Accept: 'application/json' },
        timeout: config.httpTimeoutMs
    }, 0);
    return normalize(server, profileId, data);
}

async function fetchFromSite(server: Server, profileId: string): Promise<PlayerProfile> {
    const url = `${config.moenotesSiteBase}/api/players/${server}/${encodeURIComponent(profileId)}`;
    const data = await http.request<unknown>(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: config.httpTimeoutMs
    }, 0);
    return normalize(server, profileId, data);
}

/** 出错时按**实际用的数据源**给指引: 站点路径提示去绑定/公开, 网关路径提示查网关本身 */
function classifyError(e: unknown, source: PlayerSource): Error {
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        if (status === 404) return new PlayerNotFoundError(source);
        if (status === 401 || status === 403) {
            return new PlayerUnavailableError('玩家数据源拒绝访问(MOENOTES_API_KEY 无效?)', source);
        }
        if (status === 503) return new PlayerUnavailableError('玩家数据源上游未就绪', source);
        return new PlayerUnavailableError(`玩家数据源请求失败(${status ?? 'network'})`, source);
    }
    return new PlayerUnavailableError(e instanceof Error ? e.message : String(e), source);
}

/** 查询玩家档案; 未绑定/未公开/不存在 -> PlayerNotFoundError, 上游故障 -> PlayerUnavailableError */
export async function getPlayerProfile(server: Server, profileId: string): Promise<PlayerProfile> {
    const cacheKey = `${server}/${profileId}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < config.playerTtlS * 1000) return hit.value;

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
