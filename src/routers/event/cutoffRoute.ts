import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from '../utils';
import { isServerInput, pickServer, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { Event } from '../../types/Event';
import { Song } from '../../types/Song';
import { CUTOFF_TIERS, CutoffTier } from '../../types/Cutoff';
import { storeFor } from '../../data/region';
import { getEventTracking, resolveDefaultEventId } from '../../data/events/client';
import { loadCutoffs } from '../../data/cutoff/store';
import { recordEventCutoffs, supportedTiers } from '../../data/cutoff/recorder';
import { getChallengeRanking } from '../../data/ranking/client';
import { searchEvents, textToFuzzyResult } from '../../search';
import { drawCutoffChart } from '../../view/event/cutoffChart';
import { drawEventList } from '../../view/event/eventList';

/**
 * 活动榜线(各档分数随时间的变化, 折线图)。
 *
 * 与「活动歌榜」(/eventSongRanking) 分开: 那边出的是**当前**排行榜图, 这边出的是**历史**折线图。
 * 上游没有历史接口, 数据由本地采样攒(见 data/cutoff/)。
 *
 * 参数:
 * - `id` / `eventId`: 活动 id; 传文字则走**模糊搜索** —— 命中多个活动时返回活动列表图(与查活动同款)
 * - `rank`: 只取某一档(10/100/1000/5000/10000), 不传则画全部支持的档位
 * - 服务器: 单服, 取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('eventId').optional(),
        body('rank').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, eventId, rank, compress } = req.body;
        try {
            const result = await commandCutoff(pickServer(req.body), { id, eventId, rank, compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

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

    // ---- 2. 按活动 id ----
    const explicitId = query.eventId ?? query.id;
    const eventId = explicitId === undefined ? await resolveDefaultEventId(server) : parseInt(String(explicitId), 10);
    if (eventId === undefined || !Number.isFinite(eventId)) {
        return ['错误: 该服务器当前没有开放的活动'];
    }
    return runForEvent(server, eventId, query);
}

/** 在指定服上画该活动的榜线折线图 */
async function runForEvent(server: Server, eventId: number, query: CutoffQuery): Promise<Array<Buffer | string>> {
    const event = withServer(new Event(eventId), server);
    await event.init();
    if (!event.isExist) return ['错误: 该活动不存在'];

    const songs = await challengeSongs(server, eventId);
    if (!songs.length) return ['错误: 该活动没有可记录榜线的挑战曲'];

    // 查询顺带采一次(同一个整点桶会覆盖, 不会把图撑密), 保证图上有最新一点
    const tiers = await recordEventCutoffs(server, eventId, songs.map(s => ({ musicId: s.musicId, challengeMusicId: s.challengeMusicId })))
        .catch(() => [] as CutoffTier[]);

    // 档位: 需求里的 10/100/1000/5000/10000, 但只画**数据支持**的档
    const requested = query.rank !== undefined ? [Number(query.rank) as CutoffTier] : tiers;
    const usable = requested.filter(t => (CUTOFF_TIERS as readonly number[]).includes(t));
    const notes: string[] = [];
    if (query.rank !== undefined && !usable.length) {
        const supported = tiers.length ? tiers.join(' / ') : '（本次未采到任何档位）';
        return [`错误: 该活动不支持 ${query.rank} 档榜线, 当前可用档位: ${supported}`];
    }

    const series = await loadCutoffs(server, eventId, usable.length ? usable : undefined);
    if (!series.length) notes.push('本活动还没有采样点：服务刚启动或刚接入该活动，下一小时会开始累积');

    const songMap = new Map<number, Song>();
    for (const s of songs) songMap.set(s.musicId, s.song);

    return drawCutoffChart(server, event, series, songMap, query.compress ?? false, notes);
}

/** 挑战曲: 曲目 id / 挑战曲 id(取榜用) + 已 init 的 Song; 上游追踪优先, 退回 masterdata */
interface ChallengeSong {
    musicId: number;
    challengeMusicId?: number;
    song: Song;
}

async function challengeSongs(server: Server, eventId: number): Promise<ChallengeSong[]> {
    const tracking = await getEventTracking(server, eventId).catch(() => undefined);
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

export { router as cutoffRouter };
export { getChallengeRanking };
