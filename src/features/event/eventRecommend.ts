import { isInteger } from '../../search/fuzzySearch';
import { SERVER_LIST, Server, withServer } from '../types/Server';
import { Event } from '../types/Event';
import { Song } from '../types/Song';
import { storeFor } from '../../db/adapter';
import { getEventTracking, resolveDefaultEventId } from '../../upstream/adapter';
import { searchEvents, textToFuzzyResult } from '../../search/search';
import { drawEventList } from '../../render/view/event/eventList';
import { getMusicData, recommendCharts, RECOMMEND_DIFFICULTIES, OVERHEAD_MS } from '../../upstream/adapter';
import { MusicDataScoreRank, RecommendRow } from '../types/MusicData';
import { drawEventRecommend, RecommendSection } from '../../render/view/event/eventRecommendList';

/**
 * 活动推荐曲(单服回退)的功能实现: 按站点「活动 · 评级」算法, 为击奏live 与 自由live 各自挑推荐曲。
 *
 * 每个目标评级(SS/S/A/B)一段, 段内是**所需综合力最低**的前 5 张谱面(四难度混排)。
 * 图内的 pt/小时、道具/小时由本活动的报酬表估算(演出报酬 + 挑战演出报酬两张都列)。
 * 活动 id 不传时取当前开放的活动; 服务器沿回退链依次查询, 取第一个有该活动的服。
 */

/** 每个目标评级各取前 N 张 */
const TOP_N = 10;
/** 目标评级: 站点最高的四档 */
const TARGET_RANKS: MusicDataScoreRank['rank'][] = ['SS', 'S', 'A', 'B'];
/** 挑战live 表用的目标评级(单表, 不按评级分段) */
const CHALLENGE_TARGET: MusicDataScoreRank['rank'] = 'SS';
/** 难度下标 -> 名称(Song.difficulty 的顺序) */
const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
/** 评级字母 -> 游戏表里的 liveScoreRank 数字(D/C/B/A/S/SS = 2..7) */
const RANK_NUMBERS: Record<MusicDataScoreRank['rank'], number> = { D: 2, C: 3, B: 4, A: 5, S: 6, SS: 7 };

export interface EventRecommendQuery {
    id?: unknown;
    eventId?: unknown;
    compress?: boolean;
}

/**
 * 活动推荐曲入口: 沿回退链找第一个有该活动的服, 按站点评级算法出推荐曲图。
 * 活动 id 不传取当前活动; 文本 id 多命中出活动列表图。
 */
export async function commandEventRecommend(servers: Server[], query: EventRecommendQuery = {}): Promise<Array<Buffer | string>> {
    const { compress = false } = query;
    // ---- 活动解析: id 传文本时在各服索引上依次解析(命中多个出活动列表图), 否则按 id; 不传取当前活动 ----
    const rawId = query.eventId ?? query.id;
    const textMode = rawId !== undefined && !isInteger(String(rawId));
    // 沿回退链取第一个有该活动(未指定 id 时为当前活动)的服
    for (const server of servers) {
        let wanted: number | undefined;
        if (textMode) {
            const matches = await textToFuzzyResult(server, String(rawId)).catch(() => ({}));
            if (Object.keys(matches).length === 0) continue;
            const hits = await searchEvents(server, matches).catch(() => []);
            if (hits.length === 0) continue;
            if (hits.length > 1) return drawEventList(server, hits, compress);
            wanted = hits[0].eventId;
        } else {
            wanted = rawId === undefined ? await resolveDefaultEventId(server) : parseInt(String(rawId), 10);
        }
        if (wanted === undefined || !Number.isFinite(wanted)) continue;
        const event = withServer(new Event(wanted), server);
        await event.init();
        if (!event.isExist) continue;
        return renderRecommend(server, event, wanted, compress);
    }
    if (textMode) return ['没有搜索到符合条件的活动'];
    return [rawId === undefined ? '错误: 该服务器当前没有开放的活动' : '错误: 该活动不存在'];
}

/** 在指定服上渲染该活动的推荐曲 */
async function renderRecommend(server: Server, event: Event, eventId: number, compress: boolean): Promise<Array<Buffer | string>> {
    const data = await getMusicData();
    if (!data) return ['错误: 谱面效率数据暂不可用, 请稍后再试'];

    // 一击奏一自由: 全曲池(活动挑战曲本来就在池子里, 不额外排除), 每个评级各取前 TOP_N
    const sections: RecommendSection[] = [];
    for (const mode of ['battle', 'free'] as const) {
        for (const rank of TARGET_RANKS) {
            sections.push({ mode, rank, reward: 'live', rows: recommendCharts(data, mode, rank, TOP_N) });
        }
    }

    // 挑战live 是**单独模式**: 只能用当前活动的挑战曲, 所以单开一表放在最下方,
    // 池子 = 活动曲的 HD/EX 谱面, 按目标评级 SS 的所需综合力升序**全列**(池子小, 不截前 N),
    // 报酬只算挑战演出报酬。分数模型与自由live 同口径(激走关、单人门槛)。
    const challengeIds = await challengeSongIds(server, eventId);
    const notes: string[] = [];
    if (challengeIds.length) {
        const rows = recommendCharts(data, 'free', CHALLENGE_TARGET, Number.MAX_SAFE_INTEGER, undefined, 5, challengeIds);
        // 新曲还没进 music-data 时, **借**游戏 masterdata 的门槛分 + 谱面站的定数/物量/BPM/时长 补一行:
        // 分/综合力无从取得, 那些列留「—」, 由页脚说明。
        const covered = new Set(rows.map(r => r.musicId));
        const borrowedIds = challengeIds.filter(id => !covered.has(id));
        const borrowed = await borrowedChallengeRows(server, borrowedIds, CHALLENGE_TARGET);
        if (borrowed.rows.length) {
            rows.push(...borrowed.rows);
            notes.push(`乐曲 ${borrowedIds.join(', ')} 暂无谱面模拟数据，已借游戏门槛与谱面数据补全（「—」列需等 music-data 更新）`);
        }
        if (rows.length) {
            sections.push({
                mode: 'challenge',
                rank: CHALLENGE_TARGET,
                reward: 'challenge',
                rows,
                title: `挑战live · 目标评级 ${CHALLENGE_TARGET} · 活动曲 ${RECOMMEND_DIFFICULTIES.map(d => d === 'hard' ? 'HD' : 'EX').join('/')} 按所需综合力排序`
            });
        }
    }

    // 曲目本体(标题/乐团/封面)按所选服取: 港澳台 -> 日服 -> 第一个收录的服
    const ids = [...new Set(sections.flatMap(s => s.rows.map(r => r.musicId)))];
    const songs = new Map<number, Song>();
    for (const id of ids) {
        const song = withServer(new Song(id), await firstOwner(id, server));
        await song.init();
        if (song.isExist) songs.set(id, song);
    }

    return drawEventRecommend(server, event, sections, songs, compress, TOP_N, notes);
}

/**
 * 借数据补全(谱面还没进 music-data 的歌):
 * - 定数 / 物量 / BPM / 时长  ← 谱面站(与歌曲详情同源)
 * - 评级门槛分               ← 游戏 masterdata 的 MasterLiveScoreRank(该曲 liveScoreRankGroup 下, 正好是单人门槛)
 * 分/综合力(模拟)无处可借, 所以 need 留空, 出图显示「—」。
 */
async function borrowedChallengeRows(server: Server, musicIds: number[], targetRank: MusicDataScoreRank['rank']): Promise<{ rows: RecommendRow[]; missing: number[] }> {
    const rows: RecommendRow[] = [];
    const missing: number[] = [];
    const rankNo = RANK_NUMBERS[targetRank];
    for (const musicId of musicIds) {
        const song = withServer(new Song(musicId), await firstOwner(musicId, server));
        await song.init();
        if (!song.isExist) { missing.push(musicId); continue; }
        await song.loadChartInfo(true).catch(() => undefined);
        const thresholds = await storeFor(server).liveScoreRanksByGroup(song.row?.liveScoreRankGroup ?? 0).catch(() => []);
        const threshold = thresholds.find(r => r.liveScoreRank === rankNo)?.requiredScore;
        let added = false;
        for (let i = 0; i < song.difficulty.length; i++) {
            const d = song.difficulty[i];
            const difficulty = DIFFICULTIES[i];
            if (!d?.playLevel || !(RECOMMEND_DIFFICULTIES as readonly string[]).includes(difficulty)) continue;
            rows.push({
                musicId,
                difficulty,
                displayLevel: d.displayLevel,
                notes: d.fullComboCount,
                bpmMain: Number(song.bpmText) || 0,
                bgmMs: song.durationMs,
                targetRank,
                threshold: threshold ?? undefined,
                need: undefined,
                perHour: song.durationMs ? 3.6e6 / (song.durationMs + OVERHEAD_MS) : undefined,
                source: 'borrowed'
            });
            added = true;
        }
        if (!added) missing.push(musicId);
    }
    return { rows, missing };
}

/**
 * 该活动的挑战曲(挑战live 只能选这些): 先问上游追踪, 取不到再退 masterdata 的 MasterChallengeMusic
 * (其主键 id 是挑战曲 id, liveMusicId 才是曲目 id) —— 与 /eventRanking 同一套兜底。
 */
async function challengeSongIds(server: Server, eventId: number): Promise<number[]> {
    const tracking = await getEventTracking(server, eventId).catch(() => undefined);
    if (tracking?.status === 'ok' && tracking.track.songs.length) {
        return [...new Set(tracking.track.songs.map(s => s.musicId))];
    }
    const rows = await storeFor(server).challengeMusicByEvent(eventId).catch(() => []);
    return [...new Set(rows.map(r => Number(r.liveMusicId)).filter(Number.isFinite))];
}

/** 该曲本体取哪个服的数据: 所选服优先, 没有就借港澳台 -> 日服 -> 其余 */
async function firstOwner(songId: number, server: Server): Promise<Server> {
    const ordered = [
        server,
        ...SERVER_LIST.filter(s => s === 'tw' || s === 'jp').filter(s => s !== server),
        ...SERVER_LIST.filter(s => s !== 'tw' && s !== 'jp' && s !== server)
    ];
    for (const s of ordered) {
        if (await storeFor(s).songById(songId)) return s;
    }
    return server;
}
