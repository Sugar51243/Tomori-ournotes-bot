import axios from 'axios';
import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { chainFetchBuffer } from '../sources/chain';
import { Server } from '../../features/types/Server';
import { EventRankingSong, EventRankingTrack } from '../../features/types/EventRanking';
import { EventPhase, adjustEventPhaseByTime, mayBeRunning, parseEventPhase } from '../../features/types/EventPhase';
import { regionFor } from '../../db/adapter';
import { parseGameDate } from '../../features/types/Gacha';

/**
 * 活动榜线客户端(rankd 公开接口)—— 取的就是站点活动追踪器用的那几个端点:
 *   /events/current                                 上游最近在追踪的活动
 *   /events/{eventId}                               单活动详情(含各挑战曲的最后取数时间)
 *   /events/{eventId}/challenges/{cmid}/ranking     单曲榜(见 src/upstream/ranking/client.ts)
 *
 * 取数经**数据源回退链**(gameApi 角色): bdon rankd 与 haneoka.org 的 game records 是同一份数据,
 * 主源失败时由链上的下一个源顶替(见 src/config/sources.ts)。
 *
 * 注意上游**活动结束后仍会把旧活动挂在 /events/current 上**(阶段变成 result/aggregation),
 * 所以「当前有没有活动进行中」要看活动对象的 eventStatus(见 features/types/EventPhase.ts),
 * 不能只看上游有没有返回活动。没在追踪的 id 一律 404。
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
        // 走数据源回退链(角色 gameApi): 主源失败时由备用源(haneoka.org 等)顶替
        const res = await chainFetchBuffer(`${base(server)}${path}`, {
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

    // 阶段以 eventStatus 为准; 再用同一份数据自带的 endAt 纠偏「说进行中但已过结束时间」的陈旧副本
    const phase = adjustEventPhaseByTime(parseEventPhase(raw.eventStatus), num(raw.endAt));

    return {
        status: 'ok',
        track: { eventId, eventType: num(raw.eventType) ?? 0, songs, tracked: true, phase }
    };
}

/** 上游最近在追踪的活动(**不保证还在进行中**, 看 track.phase) */
export function currentEventTracking(server: Server): Promise<EventTrackingResult> {
    return fetchEvent(server, '/events/current', `events/${server}/current.json`);
}

/** 指定活动的追踪信息(歌曲列表 + 每曲最后更新时间) */
export function getEventTracking(server: Server, eventId: number): Promise<EventTrackingResult> {
    return fetchEvent(server, `/events/${eventId}`, `events/${server}/detail_${eventId}.json`);
}

export interface CurrentEventResolution {
    /** 此刻**进行中**的活动 id; 没有则不给(不传 id 的查询据此报「没有进行中的活动」) */
    eventId?: number;
    /** 上游还挂着、但已不在进行中的活动(活动结束后上游仍把它当 current), 供出错文案提示可查往期 */
    finished?: { eventId: number; phase: EventPhase };
}

/**
 * 不传 id 时的活动解析: **只在有活动进行中时才给 id**。
 * 先问上游 /events/current(要它确实是进行中), 再退 masterdata 时间窗兜底。
 */
export async function resolveCurrentEvent(server: Server): Promise<CurrentEventResolution> {
    const current = await currentEventTracking(server);
    if (current.status === 'ok') {
        if (mayBeRunning(current.track.phase)) return { eventId: current.track.eventId };
        // 上游挂着但已知不在进行中(集计中/结果公布/已结束): 记下来给文案用, 再让时间窗找找有没有别的
        return resolveFromSchedule(server, { eventId: current.track.eventId, phase: current.track.phase as EventPhase });
    }
    return resolveFromSchedule(server);
}

/**
 * 兜底: 用本服 masterdata 自己找时间窗覆盖当下、id 最大的活动。
 * 窗口只认 [startAt, endAt] —— **不用 displayEndAt**: 结果公布期已经不是「活动进行中」了。
 */
async function resolveFromSchedule(server: Server, finished?: CurrentEventResolution['finished']): Promise<CurrentEventResolution> {
    const { store } = regionFor(server);
    const rows = await store.eventList().catch(() => []);
    const now = Date.now();
    let best: number | undefined;
    for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isFinite(id)) continue;
        const start = parseGameDate(String(row.startAt ?? ''), server);
        const end = parseGameDate(String(row.endAt ?? ''), server);
        if (!start || !end) continue;
        if (start.getTime() > now || end.getTime() < now) continue;
        if (best === undefined || id > best) best = id;
    }
    return best === undefined ? { finished } : { eventId: best, finished };
}
