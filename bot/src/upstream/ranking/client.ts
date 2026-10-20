import axios from 'axios';
import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { chainFetchBuffer } from '../sources/chain';
import { Server } from '../../features/types/Server';
import { MusicRanking, RankingEntry } from '../../features/types/Ranking';
import { ChallengeRanking } from '../../features/types/EventRanking';

/**
 * 歌曲排行客户端(rankd 公开接口)。
 * 单首歌的响应约 140KB, 必须走磁盘缓存 —— 否则反复查询会把上游和出图都拖死。
 *
 * 取数经**数据源回退链**(角色 gameApi): 主源失败时由备用源顶替; 结果带 origin(实际供数源,
 * 出图标注「数据来源」用)与 upstreamAt(上游数据时间, 链从 ETag 或数据源钩子解出)。
 */

interface RawPlayer {
    score?: number;
    playerData?: {
        id?: string;
        name?: string;
        favoriteMemberCard?: { cardId?: string };
    };
    highScoreDeck?: { cards?: Array<{ memberCard?: { cardId?: string } }>; totalPower?: number };
}

/** 上游可能给字符串数字, 也可能缺字段 */
function numOrUndef(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function toEntries(players: RawPlayer[]): RankingEntry[] {
    return players.map((p, i) => ({
        rank: i + 1,
        score: Number(p.score ?? 0),
        playerId: String(p.playerData?.id ?? ''),
        playerName: String(p.playerData?.name ?? ''),
        cardId: p.playerData?.favoriteMemberCard?.cardId
            ?? p.highScoreDeck?.cards?.[0]?.memberCard?.cardId,
        deckPower: numOrUndef(p.highScoreDeck?.totalPower)
    }));
}

/** 取某服某首歌的前十名; 上游无数据时返回空列表 */
export async function getMusicRanking(server: Server, musicId: number, limit = 10): Promise<MusicRanking> {
    const empty: MusicRanking = { server, musicId, entries: [] };
    const res = await chainFetchBuffer(`${config.gameApiBase}/api/v1/${server}/music/${musicId}/ranking`, {
        key: `ranking/${server}/music_${musicId}.json`,
        ttlS: ttl.rankingTtlS,
        allowStale: true,
        revalidate: true
    }).catch(() => undefined);
    if (!res) return empty;
    try {
        const body = JSON.parse(res.data.toString('utf8')) as { players?: RawPlayer[] };
        if (!Array.isArray(body.players)) return { ...empty, origin: res.origin };
        return { server, musicId, entries: toEntries(body.players.slice(0, Math.max(1, limit))), origin: res.origin };
    } catch {
        return { ...empty, origin: res.origin };
    }
}

/**
 * 活动挑战曲榜 —— 站点活动追踪器用的就是这个端点(`/events/{eventId}/challenges/{cmid}/ranking`)。
 *
 * 与 `/music/{musicId}/ranking` 的区别不只是路径: 后者是曲子的历史最高分榜(活动曲在活动开始前
 * 往往查不到数据), 前者是**本次活动内**该挑战曲的榜, 活动期间的榜线数据以它为准。
 * 响应体形状两者一致, 共用 toEntries。
 *
 * 上游对该曲榜报错(未开始/未开放排名/尚未采集/正在获取)时返回 errorKind, 由出图说明原因。
 */
export async function getChallengeRanking(server: Server, eventId: number, challengeMusicId: number, limit = 10): Promise<ChallengeRanking> {
    const url = `${config.gameApiBase}/api/v1/${server}/events/${eventId}/challenges/${challengeMusicId}/ranking`;
    let data: Buffer | undefined;
    let fetchedAt: number | undefined;
    let origin: string | undefined;
    try {
        const res = await chainFetchBuffer(url, {
            key: `ranking/${server}/event_${eventId}_challenge_${challengeMusicId}.json`,
            ttlS: ttl.rankingTtlS,
            allowStale: true,
            revalidate: true
        });
        data = res?.data;
        origin = res?.origin;
        // 上游时间: 数据源自己给的优先(haneoka 的 fetchedAtMs), 否则从 ETag 解(bdon rankd)
        fetchedAt = res?.upstreamAt ?? fetchedAtFromEtag(res?.etag);
    } catch (e) {
        return { entries: [], errorKind: errorKindOf(e) };
    }
    if (!data) return { entries: [], errorKind: 'upstream' };
    try {
        const body = JSON.parse(data.toString('utf8')) as { players?: RawPlayer[] };
        if (!Array.isArray(body.players)) return { entries: [], fetchedAt, origin };
        return { entries: toEntries(body.players.slice(0, Math.max(1, limit))), fetchedAt, origin };
    } catch {
        return { entries: [], fetchedAt, origin };
    }
}

/**
 * 从上游 ETag 解出「该数据是什么时候抓的」。
 *
 * rankd 的 ETag 末段就是响应头 `x-fetched-at`(epoch ms)的 base36:
 * `W/"c-tw-1-1-muqxd7ip"` / `W/"m100001-muqwxo8n"` -> parseInt('muqxd7ip', 36) = x-fetched-at。
 * ETag 会被 cachedFetch 落盘, 所以**缓存命中也拿得到上游时间**(响应头做不到这一点)。
 * 解不出/不像时间就返回 undefined, 调用方自行降级。
 */
export function fetchedAtFromEtag(etag?: string): number | undefined {
    if (!etag) return undefined;
    // 可能是弱校验器并带引号: W/"..." 或 "..."
    const cleaned = etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const seg = cleaned.split('-').pop();
    if (!seg || !/^[0-9a-z]+$/.test(seg)) return undefined;
    const ms = parseInt(seg, 36);
    // 合理性校验: 2020-01-01 ~ 现在+7天(容忍上游时钟略快)
    const MIN = 1577836800000;
    const MAX = Date.now() + 7 * 24 * 3600_000;
    return Number.isFinite(ms) && ms >= MIN && ms <= MAX ? ms : undefined;
}

/** 上游错误体形如 {error:{kind:'challenge_not_collected'}}; 网络故障给 'upstream' */
function errorKindOf(e: unknown): string {
    const body = axios.isAxiosError(e) ? e.response?.data : undefined;
    if (Buffer.isBuffer(body)) {
        try {
            const parsed = JSON.parse(body.toString('utf8')) as { error?: { kind?: unknown } };
            if (typeof parsed?.error?.kind === 'string') return parsed.error.kind;
        } catch { /* 非 JSON 错误体 */ }
    }
    return 'upstream';
}

