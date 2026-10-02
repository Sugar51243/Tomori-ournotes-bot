import { config } from '../../config';
import { logger } from '../../logger';
import { SERVER_LIST, Server } from '../../types/Server';
import { CUTOFF_TIERS, CutoffSample, CutoffTier } from '../../types/Cutoff';
import { RankingEntry } from '../../types/Ranking';
import { EventRankingSong } from '../../types/EventRanking';
import { currentEventTracking } from '../events/client';
import { getChallengeRanking } from '../ranking/client';
import { hourBucket, recordCutoffs } from './store';

/**
 * 榜线采样器。
 *
 * 上游只给**当前快照**(挑战曲榜前 100), 没有历史 —— 所以这里按小时采样并落库/落内存,
 * 折线图的数据就是这些采样点。除了定时采样, 每次用户查询也会立即采一次(同一个整点桶内
 * 后面的覆盖前面的, 不会把图撑密)。
 *
 * 档位适配: 榜里第 N 条就是第 N 名, 所以只有「≤ 实际榜单长度」的档位才算数
 * (上游固定前 100 → 1000/5000/10000 自动不适配)。
 */

/** 从一份榜单里取某档的分数(第 tier 名的 score); 榜不足该档返回 null */
export function scoreAtRank(entries: RankingEntry[], tier: number): number | null {
    const entry = entries[tier - 1];
    return entry && Number.isFinite(entry.score) ? entry.score : null;
}

/** 该榜单支持哪些档位 */
export function supportedTiers(entries: RankingEntry[]): CutoffTier[] {
    return CUTOFF_TIERS.filter(t => scoreAtRank(entries, t) !== null);
}

/**
 * 采一次活动榜线: 每个挑战曲 × 每个支持的档位 各留一个点。
 * 取榜用 challengeMusicId(不是曲目 id), 榜长取上游上限 100 —— 正好够判 10 / 100 两档。
 * @returns 采到的样本与该活动实际支持的档位(取各曲的并集, 供出图/校验用)
 */
export async function sampleEventCutoffs(server: Server, eventId: number, songs: EventRankingSong[]): Promise<{ samples: CutoffSample[]; tiers: CutoffTier[] }> {
    // 一次采样只取一个时刻: 桶与 recordedAt 必须是同一时间点, 否则整点边界上会写出桶与时间对不上的点
    const now = Date.now();
    const bucket = hourBucket(now);
    const samples: CutoffSample[] = [];
    const tiers = new Set<CutoffTier>();
    for (const song of songs) {
        if (song.challengeMusicId === undefined) continue;
        const ranking = await getChallengeRanking(server, eventId, song.challengeMusicId, 100).catch(() => undefined);
        const list = ranking?.entries ?? [];
        for (const tier of supportedTiers(list)) {
            tiers.add(tier);
            samples.push({
                musicId: song.musicId,
                tier,
                bucket,
                score: scoreAtRank(list, tier) ?? 0,
                recordedAt: now,
                // 每条样本带**它自己那首歌**的上游时间, 而不是全活动取 max —— 各曲榜的刷新时间可能不同
                upstreamAt: ranking?.fetchedAt
            });
        }
    }
    return { samples, tiers: [...tiers].sort((a, b) => a - b) };
}

/**
 * 查询触发的采样冷却状态(按 服|活动)。定时采样不受限。
 * - `at`: 上次尝试采样的时刻 —— 在 await 之前就写入, 于是一串并发查询里只有第一个真正去采
 * - `tiers`: 上次采到的档位, CD 内直接复用, 免得画图/校验档位时"看起来什么都没有"
 * - `inflight`: 进行中的采样 —— 冷启动后的第二个并发查询还没得可复用时, 等它而不是空手而归
 */
interface RecordState {
    at: number;
    tiers?: CutoffTier[];
    inflight?: Promise<CutoffTier[]>;
}
const recordStates = new Map<string, RecordState>();

/**
 * 采一次并写入存储(定时任务与用户查询都走这里)。
 *
 * 查询路径有冷却(见 `CUTOFF_QUERY_RECORD_MIN_INTERVAL_S`): 短时间内重复查询直接沿用上次的
 * 采样结果 —— 上游榜本来就最多 RANKING_TTL_S 才更新一次, 再采一遍只是重复解析 140KB JSON
 * 并重写一行数据库。冷却内的查询依然按请求的档位出图, 不误报"不支持该档"。
 *
 * @param opts.force 定时采样用: 跳过冷却, 保证每小时必定落点
 * @returns 该活动实际支持的档位(冷却命中时返回上次采到的)
 */
export async function recordEventCutoffs(server: Server, eventId: number, songs: EventRankingSong[], opts: { force?: boolean } = {}): Promise<CutoffTier[]> {
    const key = `${server}|${eventId}`;
    const cdMs = config.cutoffQueryRecordMinIntervalS * 1000;
    const state = recordStates.get(key);
    const fresh = !!state && Date.now() - state.at < cdMs;

    if (!opts.force && cdMs > 0 && fresh) {
        // 冷启动的突发: 还没有可复用的档位, 等第一个采完再按它的结果走, 别返回空档位
        if (!state?.tiers && state?.inflight) return state.inflight;
        logger('cutoff', `[${server}] event ${eventId}: skip sampling (cooldown ${config.cutoffQueryRecordMinIntervalS}s)`);
        return state?.tiers ?? [];
    }

    const entry: RecordState = { at: Date.now(), tiers: state?.tiers };
    const inflight = (async () => {
        try {
            const { samples, tiers } = await sampleEventCutoffs(server, eventId, songs);
            await recordCutoffs(server, eventId, samples);
            // 上游抖动时可能一个档位都没采到 —— 别用空结果覆盖上次的可用档位
            if (tiers.length || !entry.tiers) entry.tiers = tiers;
            return entry.tiers ?? [];
        } catch (e) {
            // 采样失败: 撤销时间戳让下次查询立刻重试, 保留已缓存的档位
            if (recordStates.get(key) === entry) recordStates.delete(key);
            throw e;
        } finally {
            entry.inflight = undefined;
        }
    })();
    entry.inflight = inflight;
    recordStates.set(key, entry);
    return inflight;
}

let timer: NodeJS.Timeout | undefined;

/**
 * 启动定时采样(每个区域各自解析当前活动; 没有在追踪的活动就跳过这一轮)。
 * 与公告轮询不同, 这里**常驻**——历史得一直攒, 不能等有人订阅才开始。
 */
export function startCutoffRecorder(): void {
    if (timer) return;
    // 下限 10s: 生产不会这么配(默认 3600), 但自检要在假上游上快速攒点
    const intervalMs = Math.max(10, config.cutoffRecordIntervalS) * 1000;
    logger('cutoff', `start recording every ${Math.round(intervalMs / 1000)}s`);
    const tick = async (): Promise<void> => {
        for (const server of SERVER_LIST) {
            try {
                const tracking = await currentEventTracking(server);
                if (tracking.status !== 'ok') continue;
                if (!tracking.track.songs.length) continue;
                // force: 定时采样不受查询冷却影响, 保证每个采样周期必定落点
                const tiers = await recordEventCutoffs(server, tracking.track.eventId, tracking.track.songs, { force: true });
                logger('cutoff', `[${server}] event ${tracking.track.eventId}: recorded tiers ${tiers.join(',') || '(none)'}`);
            } catch (e) {
                logger('cutoff', `[${server}] record failed: ${e instanceof Error ? e.message : e}`);
            }
        }
    };
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
}

export function stopCutoffRecorder(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
