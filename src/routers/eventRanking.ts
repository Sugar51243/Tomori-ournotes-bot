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
 * 活动歌榜(活动歌曲排行榜)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器由单值 `server` 指定(兼容 tsugu 的 `mainServer`); 活动 id 不传时取该服**当前开放的活动**。
 *
 * 同一 router 挂两个路径:
 * - `/eventSongRanking` —— 正名(活动歌榜)
 * - `/eventRanking`     —— 旧路径, 保留兼容
 *
 * `rank` 参数(榜线): 10 / 100 / 1000 / 5000 / 10000 —— 取**到该名次为止的 10 名**画图
 * (如 rank=100 → 第 91~100 名)。上游每曲榜固定只给前 100, 所以超出数据范围的档位
 * **不适配**: 该曲的段里会注明「榜不足该档」, 完全不支持时返回领域错误并列出可用档位。
 */
const router = express.Router();

/** 需求里列出的档位; 实际能不能用由该曲榜的长度决定 */
const CUTOFF_TIERS = [10, 100, 1000, 5000, 10000] as const;
/** 每档展示的行数(往上 10 名) */
const TIER_WINDOW = 10;

router.post(
    '/',
    [
        body('server').optional().custom(isServer),
        body('mainServer').optional().custom(isServer),
        body('id').optional().isInt({ min: 1 }),
        body('eventId').optional().isInt({ min: 1 }),
        body('rank').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, eventId, rank, compress } = req.body;
        try {
            const result = await commandEventRanking(pickServer(req.body), eventId ?? id, compress, rank);
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
export async function commandEventRanking(server: Server, eventId?: number | string, compress = false, rank?: number): Promise<Array<Buffer | string>> {
    const wanted = eventId === undefined ? await resolveDefaultEventId(server) : parseInt(String(eventId), 10);
    if (wanted === undefined || !Number.isFinite(wanted)) {
        return ['错误: 该服务器当前没有开放的活动'];
    }
    // 榜线档位: 不传 = 前 10(原来的行为); 传了则取「到该名次为止的 10 名」
    const tier = rank === undefined ? 10 : Number(rank);
    if (!Number.isFinite(tier) || tier < 1) return ['错误: 榜线档位不合法'];

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

    // 挑战曲走活动内的榜(与站点活动追踪器同源); 兜底拿不到挑战曲 id 时才退回普通歌曲榜。
    // 取前 `tier` 名(上游每曲最多前 100), 再截取「往上 10 名」的那一段。
    const fetched: ChallengeRanking[] = await Promise.all(sections.map(s => s.challengeMusicId !== undefined
        ? getChallengeRanking(server, wanted, s.challengeMusicId, tier)
        : getMusicRanking(server, s.musicId, tier).then(r => ({ entries: r.entries }))));

    // 数据支持哪些档位: 任一曲的榜长达到该档就算(需求: 数据不支持的档位就不适配)
    const maxRank = Math.max(0, ...fetched.map(f => f.entries.length));
    if (tier > 10 && maxRank < tier) {
        const usable = (CUTOFF_TIERS as readonly number[]).filter(t => t <= maxRank && t <= 100);
        return [`错误: 该活动不支持 ${tier} 档榜线${usable.length ? `，当前可用档位: ${usable.join(' / ')}` : ''}`];
    }

    sections.forEach((section, i) => {
        const all = fetched[i].entries;
        section.ranking = { server, musicId: section.musicId, entries: all.slice(Math.max(0, tier - TIER_WINDOW), tier) };
        section.errorKind = fetched[i].errorKind;
        // 该曲榜不足这个档 -> 这一段标注出来(其它曲照常画)
        if (all.length < tier) section.errorKind = section.errorKind ?? 'tier_not_collected';
        // 窗口固定是「到该档为止的 10 名」: 90 名开外就取不满, 空榜也照标名次区间
        section.rankStart = Math.max(1, tier - TIER_WINDOW + 1);
        section.rankEnd = tier;
    });

    return drawEventRanking(server, event, sections, compress, notes, { start: Math.max(1, tier - TIER_WINDOW + 1), end: tier });
}

export { router as eventRankingRouter };
