import { isInteger } from '../../search/fuzzySearch';
import { Server, withServer } from '../types/Server';
import { Event } from '../types/Event';
import { Song } from '../types/Song';
import { CUTOFF_TIERS, CutoffTier } from '../types/Cutoff';
import { isEventNotRunning } from '../types/EventPhase';
import { formatGameDate } from '../types/Gacha';
import { storeFor } from '../../db/adapter';
import { EventTrackingResult, getEventTracking, resolveCurrentEvent } from '../../upstream/adapter';
import { loadCutoffs } from '../../db/adapter';
import { recordEventCutoffs } from '../../tasks/cutoff/recorder';
import { getChallengeRanking } from '../../upstream/adapter';
import { searchEvents, textToFuzzyResult } from '../../search/search';
import { noCurrentEventText } from './currentEvent';
import { drawCutoffChart } from '../../render/view/event/cutoffChart';
import { drawEventList } from '../../render/view/event/eventList';

/**
 * 活动榜线(各档分数随时间的变化, 折线图)的功能实现。
 *
 * 与「活动歌榜」(/eventSongRanking) 分开: 那边出的是**当前**排行榜图, 这边出的是**历史**折线图。
 * 上游没有历史接口, 数据由本地采样攒(见 tasks/cutoff/ 与 db/cutoff/)。
 *
 * 参数:
 * - `id` / `eventId`: 活动 id; 传文字则走**模糊搜索** —— 命中多个活动时返回活动列表图(与查活动同款)
 * - `rank`: 只取某一档(10/100/1000/5000/10000), 不传则画全部支持的档位
 * - 服务器: 单服, 取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**
 *
 * 活动阶段: 不传 id 时只认**进行中**的活动(上游在活动结束后仍会挂着旧活动, 见
 * upstream/events/client.ts); 显式带 id 时已结束/集计中/结果公布照常出图并标注阶段,
 * **但只有进行中的活动才会触发采样** —— 已结束的活动榜已定格, 采了只是往图上钉重复点。
 */

export interface CutoffQuery {
    id?: unknown;
    eventId?: unknown;
    rank?: number;
    compress?: boolean;
}

/** 服务器由调用方给出: 单服, 只取输入的首项(单值即该服), 不允许回退 */
export async function commandCutoff(server: Server, query: CutoffQuery = {}): Promise<Array<Buffer | string>> {
    // ---- 1. 活动解析: id 传文本时走模糊搜索(命中多个出活动列表), 否则按 id ----
    const rawId = query.eventId ?? query.id;
    if (rawId !== undefined && !isInteger(String(rawId))) {
        const matches = await textToFuzzyResult(server, String(rawId));
        if (Object.keys(matches).length === 0) return ['错误: 没有有效的关键词'];
        const hits = await searchEvents(server, matches);
        if (hits.length === 0) return ['没有搜索到符合条件的活动'];
        // 多活动 -> 返回查活动(列表图), 让用户挑一个再查
        if (hits.length > 1) return drawEventList(server, hits, query.compress ?? false);
        return runForEvent(server, hits[0].eventId, query);
    }

    // ---- 2. 不传 id -> 当前进行中的活动; 确实没有就报错(不再拿上游挂着的已结束活动充数) ----
    if (rawId === undefined) {
        const current = await resolveCurrentEvent(server);
        if (current.eventId === undefined) return [noCurrentEventText(server, current.finished, '榜线')];
        return runForEvent(server, current.eventId, query);
    }

    // ---- 3. 按活动 id ----
    const eventId = parseInt(String(rawId), 10);
    if (!Number.isFinite(eventId)) return ['错误: 活动 ID 不合法'];
    return runForEvent(server, eventId, query);
}

/** 在指定服上画该活动的榜线折线图 */
async function runForEvent(server: Server, eventId: number, query: CutoffQuery): Promise<Array<Buffer | string>> {
    const event = withServer(new Event(eventId), server);
    await event.init();
    if (!event.isExist) return ['错误: 该活动不存在'];

    const tracking = await getEventTracking(server, eventId).catch(() => undefined);
    event.upstreamPhase = tracking?.status === 'ok' ? tracking.track.phase : undefined;
    const phase = event.phase();
    if (phase === 'feature') {
        return [`错误: 该活动尚未开始${event.startAt ? `（${formatGameDate(event.startAt, server)} 开始）` : ''}，暂无榜线数据`];
    }
    // 阶段未知时保守放行(与旧行为一致), 只有**已知不在进行中**才停掉采样
    const running = !isEventNotRunning(phase);

    const songs = await challengeSongs(server, eventId, tracking);
    if (!songs.length) return ['错误: 该活动没有可记录榜线的挑战曲'];

    // 查询顺带采一次(同一个整点桶会覆盖, 不会把图撑密), 保证图上有最新一点。
    // 采样有冷却(CUTOFF_QUERY_RECORD_MIN_INTERVAL_S), 短时间内重复查询直接复用上次结果
    const sampled = running
        ? await recordEventCutoffs(server, eventId, songs.map(s => ({ musicId: s.musicId, challengeMusicId: s.challengeMusicId })))
            .catch(() => [] as CutoffTier[])
        : [];

    // 可用档位: 本次采样优先; 没采样(活动已结束)时看**已存历史**支持哪些档 ——
    // 否则有历史数据的已结束活动会被误报「不支持该档」
    const { series, meta } = await loadCutoffs(server, eventId);
    const storedTiers = [...new Set(series.map(s => s.tier))].sort((a, b) => a - b);
    const supported = sampled.length ? sampled : storedTiers;

    const requested = query.rank !== undefined ? [Number(query.rank) as CutoffTier] : supported;
    const usable = requested.filter(t => (CUTOFF_TIERS as readonly number[]).includes(t));
    if (query.rank !== undefined && !usable.length) {
        const list = supported.length ? supported.join(' / ') : '（本地还没有该活动的榜线记录）';
        return [`错误: 该活动不支持 ${query.rank} 档榜线, 当前可用档位: ${list}`];
    }

    // 档位过滤放在内存里做(loadCutoffs 已经取了全量, 顺带能得上面的 storedTiers)
    const shown = usable.length ? series.filter(s => usable.includes(s.tier)) : series;
    const songMap = new Map<number, Song>();
    for (const s of songs) songMap.set(s.musicId, s.song);

    return drawCutoffChart(server, event, shown, songMap, query.compress ?? false, [], meta);
}


/** 挑战曲: 曲目 id / 挑战曲 id(取榜用) + 已 init 的 Song; 上游追踪优先, 退回 masterdata */
interface ChallengeSong {
    musicId: number;
    challengeMusicId?: number;
    song: Song;
}

async function challengeSongs(server: Server, eventId: number, tracking?: EventTrackingResult): Promise<ChallengeSong[]> {
    let pairs: Array<{ musicId: number; challengeMusicId?: number }>;
    if (tracking?.status === 'ok' && tracking.track.songs.length) {
        pairs = tracking.track.songs.map(s => ({ musicId: s.musicId, challengeMusicId: s.challengeMusicId }));
    } else {
        // MasterChallengeMusic 的主键 id 是挑战曲 id, liveMusicId 才是曲目 id
        pairs = (await storeFor(server).challengeMusicByEvent(eventId).catch(() => []))
            .map(r => ({ musicId: Number(r.liveMusicId), challengeMusicId: Number(r.id) }))
            .filter(p => Number.isFinite(p.musicId));
    }
    const out: ChallengeSong[] = [];
    const seen = new Set<number>();
    for (const p of pairs) {
        if (seen.has(p.musicId)) continue;
        seen.add(p.musicId);
        const song = withServer(new Song(p.musicId), server);
        await song.init();
        if (song.isExist) out.push({ ...p, song });
    }
    return out;
}

export { getChallengeRanking };
