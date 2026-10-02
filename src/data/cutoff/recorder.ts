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
    const bucket = hourBucket();
    const samples: CutoffSample[] = [];
    const tiers = new Set<CutoffTier>();
    for (const song of songs) {
        if (song.challengeMusicId === undefined) continue;
        const ranking = await getChallengeRanking(server, eventId, song.challengeMusicId, 100).catch(() => undefined);
        const list = ranking?.entries ?? [];
        for (const tier of supportedTiers(list)) {
            tiers.add(tier);
            samples.push({ musicId: song.musicId, tier, bucket, score: scoreAtRank(list, tier) ?? 0 });
        }
    }
    return { samples, tiers: [...tiers].sort((a, b) => a - b) };
}

/** 采一次并写入存储(定时任务与用户查询都走这里) */
export async function recordEventCutoffs(server: Server, eventId: number, songs: EventRankingSong[]): Promise<CutoffTier[]> {
    const { samples, tiers } = await sampleEventCutoffs(server, eventId, songs);
    await recordCutoffs(server, eventId, samples);
    return tiers;
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
                const tiers = await recordEventCutoffs(server, tracking.track.eventId, tracking.track.songs);
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
