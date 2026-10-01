import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServer, pickServer, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { Event } from '../types/Event';
import { Song } from '../types/Song';
import { regionFor } from '../data/region';
import { getEventTracking, resolveDefaultEventId } from '../data/events/client';
import { getChallengeRanking, getMusicRanking } from '../data/ranking/client';
import { ChallengeRanking } from '../types/EventRanking';
import { drawEventRanking, EventRankingSection } from '../view/eventRanking';

/**
 * 活动榜线(活动排行榜)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器由单值 `server` 指定(兼容 tsugu 的 `mainServer`); 活动 id 不传时取该服**当前开放的活动**。
 *
 * 同一 router 挂两个路径:
 * - `/eventRanking` —— 语义直白的正名
 * - `/cutoffAll`   —— tsugu 客户端的榜线接口名(补全原 404 占位)
 */
const router = express.Router();

router.post(
    '/',
    [
        body('server').optional().custom(isServer),
        body('mainServer').optional().custom(isServer),
        body('id').optional().isInt({ min: 1 }),
        body('eventId').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, eventId, compress } = req.body;
        try {
            const result = await commandEventRanking(pickServer(req.body), eventId ?? id, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/**
 * 活动榜线出图。歌曲列表三级兜底:
 *   1. 上游追踪(带每曲最后更新时间, 首选)
 *   2. masterdata 的 MasterChallengeMusic(挑战演出活动; 无更新时间)
 *   3. 其它活动类型: 活动本曲(MasterEvent.musicId)的榜
 */
export async function commandEventRanking(server: Server, eventId?: number | string, compress = false): Promise<Array<Buffer | string>> {
    const wanted = eventId === undefined ? await resolveDefaultEventId(server) : parseInt(String(eventId), 10);
    if (wanted === undefined || !Number.isFinite(wanted)) {
        return ['错误: 该服务器当前没有开放的活动'];
    }

    const event = withServer(new Event(wanted), server);
    await event.init();
    if (!event.isExist) return ['错误: 该活动不存在'];

    const tracking = await getEventTracking(server, wanted);
    const { store } = regionFor(server);
    const notes: string[] = [];

    // ---- 歌曲列表 ----
    let songs = tracking.status === 'ok' ? tracking.track.songs : [];
    if (!songs.length) {
        // MasterChallengeMusic 的主键 id 就是挑战曲 id, liveMusicId 才是曲目 id
        const rows = await store.challengeMusicByEvent(wanted).catch(() => []);
        songs = rows
            .map(r => ({ musicId: Number(r.liveMusicId), challengeMusicId: Number(r.id) }))
            .filter(s => Number.isFinite(s.musicId));
    }
    if (!songs.length && !event.row?.isMusicRankingDisabled && event.row?.musicId) {
        // 非挑战演出活动没有 MasterChallengeMusic, 退到活动自己的曲目(没有挑战曲 id, 只能取普通歌曲榜)
        const musicId = Number(event.row.musicId);
        if (Number.isFinite(musicId)) songs = [{ musicId }];
    }

    const sections: EventRankingSection[] = [];
    const missing: number[] = [];
    for (const s of songs) {
        const song = withServer(new Song(s.musicId), server);
        await song.init();
        if (!song.isExist) {
            missing.push(s.musicId);
            continue;
        }
        sections.push({
            song,
            musicId: s.musicId,
            challengeMusicId: s.challengeMusicId,
            ranking: { server, musicId: s.musicId, entries: [] },
            lastFetchedAt: s.lastFetchedAt,
            stale: s.stale
        });
    }
    if (missing.length) notes.push(`本服未收录乐曲 ${missing.join(', ')}，已省略`);

    // 挑战曲走活动内的榜(与站点活动追踪器同源); 兜底拿不到挑战曲 id 时才退回普通歌曲榜
    const fetched: ChallengeRanking[] = await Promise.all(sections.map(s => s.challengeMusicId !== undefined
        ? getChallengeRanking(server, wanted, s.challengeMusicId, 10)
        : getMusicRanking(server, s.musicId, 10).then(r => ({ entries: r.entries }))));
    sections.forEach((section, i) => {
        section.ranking = { server, musicId: section.musicId, entries: fetched[i].entries };
        section.errorKind = fetched[i].errorKind;
    });

    return drawEventRanking(server, event, sections, compress, notes);
}

export { router as eventRankingRouter };
