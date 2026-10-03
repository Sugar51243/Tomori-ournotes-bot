import axios from 'axios';
import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { cachedFetch } from '../cachedFetch';
import { Server } from '../../features/types/Server';
import { EventRankingSong, EventRankingTrack } from '../../features/types/EventRanking';
import { regionFor } from '../../db/adapter';
import { parseGameDate } from '../../features/types/Gacha';

/**
 * 活动榜线客户端(rankd 公开接口)—— 取的就是站点活动追踪器用的那几个端点:
 *   /events/current                                 当前开放的活动
 *   /events/{eventId}                               单活动详情(含各挑战曲的最后取数时间)
 *   /events/{eventId}/challenges/{cmid}/ranking     单曲榜(见 src/upstream/ranking/client.ts)
 *
 * 上游只跟踪**当前开放**的活动, 没在追踪的 id 一律 404。
 */

function base(server: Server): string {
    return `${config.gameApiBase}/api/v1/${server}`;
}

interface RawChallengeRanking {
    challengeMusicId?: number | string;
    musicId?: number | string;
    rankingEnabled?: boolean;
    collectStatus?: string;
    lastFetchedAt?: number;
    stale?: boolean;
    refreshing?: boolean;
}

export interface RawTrackedEvent {
    eventId?: number | string;
    eventType?: number | string;
    eventStatus?: string;
    startAt?: number;
    endAt?: number;
    displayEndAt?: number;
    rankingDisabled?: boolean;
    musicRankingDisabled?: boolean;
    totalMusicRankingDisabled?: boolean;
    pointRanking?: { enabled?: boolean };
    challengeRankings?: RawChallengeRanking[];
}

function num(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** 上游的响应体里有活动对象就直接当活动解析(单活动端点与 /events/current 都是这个形状) */
function parseEvent(buf: Buffer): RawTrackedEvent | undefined {
    try {
        const body = JSON.parse(buf.toString('utf8')) as RawTrackedEvent & { events?: unknown };
        if (Array.isArray(body.events)) return body.events[0] as RawTrackedEvent | undefined;
        return body && typeof body === 'object' && body.eventId !== undefined ? body : undefined;
    } catch {
        return undefined;
    }
}

export type EventTrackingResult =
    | { status: 'ok'; track: EventRankingTrack }
    /** 上游没在追踪这个活动(404) —— 不代表活动不存在, 只是没有榜线数据 */
    | { status: 'not_tracked' }
    /** 网络/5xx 等临时故障 */
    | { status: 'unavailable' };

async function fetchEvent(server: Server, path: string, key: string): Promise<EventTrackingResult> {
    let data: Buffer | undefined;
    try {
        const res = await cachedFetch(`${base(server)}${path}`, {
            key,
            ttlS: ttl.rankingTtlS,
            allowStale: true,
            revalidate: true
        });
        data = res?.data;
    } catch (e) {
        return axios.isAxiosError(e) && e.response?.status === 404 ? { status: 'not_tracked' } : { status: 'unavailable' };
    }
    const raw = data ? parseEvent(data) : undefined;
    if (!raw) return { status: 'unavailable' };

    const eventId = num(raw.eventId);
    if (eventId === undefined) return { status: 'unavailable' };

    // 按挑战曲 id 去重(缺 challengeMusicId 的老数据退回 musicId), 保持上游顺序
    const seen = new Set<number>();
    const songs: EventRankingSong[] = [];
    for (const c of raw.challengeRankings ?? []) {
        if (c.rankingEnabled === false) continue;
        const musicId = num(c.musicId);
        if (musicId === undefined) continue;
        const challengeMusicId = num(c.challengeMusicId);
        const dedupeKey = challengeMusicId ?? musicId;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        songs.push({
            musicId,
            challengeMusicId,
            lastFetchedAt: num(c.lastFetchedAt),
            stale: c.stale === true,
            refreshing: c.refreshing === true
        });
    }

    return {
        status: 'ok',
        track: { eventId, eventType: num(raw.eventType) ?? 0, songs, tracked: true }
    };
}

/** 上游正在追踪的**当前**活动 */
export function currentEventTracking(server: Server): Promise<EventTrackingResult> {
    return fetchEvent(server, '/events/current', `events/${server}/current.json`);
}

/** 指定活动的追踪信息(歌曲列表 + 每曲最后更新时间) */
export function getEventTracking(server: Server, eventId: number): Promise<EventTrackingResult> {
    return fetchEvent(server, `/events/${eventId}`, `events/${server}/detail_${eventId}.json`);
}

/** 不传 id 时: 该服当前开放的活动(先问上游 /events/current, 再退 masterdata 的时间窗) */
export async function resolveDefaultEventId(server: Server): Promise<number | undefined> {
    const current = await currentEventTracking(server);
    if (current.status === 'ok') return current.track.eventId;

    // 上游没给(未追踪/不可用) -> 用本服 masterdata 自己找: 时间窗覆盖当下且 id 最大的那个
    const { store } = regionFor(server);
    const rows = await store.eventList().catch(() => []);
    const now = Date.now();
    let best: number | undefined;
    for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isFinite(id)) continue;
        const start = parseGameDate(String(row.startAt ?? ''), server);
        const end = parseGameDate(String(row.displayEndAt ?? row.endAt ?? ''), server);
        if (!start || !end) continue;
        if (start.getTime() > now || end.getTime() < now) continue;
        if (best === undefined || id > best) best = id;
    }
    return best;
}
