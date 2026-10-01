import axios from 'axios';
import { config } from '../../config';
import { cachedFetch } from '../cachedFetch';
import { Server } from '../../types/Server';
import { MusicRanking, RankingEntry } from '../../types/Ranking';
import { ChallengeRanking } from '../../types/EventRanking';

/**
 * 歌曲排行客户端(rankd 公开接口)。
 * 单首歌的响应约 140KB, 必须走磁盘缓存 —— 否则反复查询会把上游和出图都拖死。
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
    const res = await cachedFetch(`${config.gameApiBase}/api/v1/${server}/music/${musicId}/ranking`, {
        key: `ranking/${server}/music_${musicId}.json`,
        ttlS: config.rankingTtlS,
        allowStale: true,
        revalidate: true
    }).catch(() => undefined);
    if (!res) return empty;
    try {
        const body = JSON.parse(res.data.toString('utf8')) as { players?: RawPlayer[] };
        if (!Array.isArray(body.players)) return empty;
        return { server, musicId, entries: toEntries(body.players.slice(0, Math.max(1, limit))) };
    } catch {
        return empty;
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
    try {
        const res = await cachedFetch(url, {
            key: `ranking/${server}/event_${eventId}_challenge_${challengeMusicId}.json`,
            ttlS: config.rankingTtlS,
            allowStale: true,
            revalidate: true
        });
        data = res?.data;
    } catch (e) {
        return { entries: [], errorKind: errorKindOf(e) };
    }
    if (!data) return { entries: [], errorKind: 'upstream' };
    try {
        const body = JSON.parse(data.toString('utf8')) as { players?: RawPlayer[] };
        if (!Array.isArray(body.players)) return { entries: [] };
        return { entries: toEntries(body.players.slice(0, Math.max(1, limit))) };
    } catch {
        return { entries: [] };
    }
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

