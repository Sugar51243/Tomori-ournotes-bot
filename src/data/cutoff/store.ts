import { config } from '../../config';
import { logger } from '../../logger';
import { Server } from '../../types/Server';
import { CutoffDoc, CutoffSample, CutoffSeries, CutoffTier } from '../../types/Cutoff';
import { cutoffsCollection, dbConfigured } from '../mongo';

/**
 * 榜线历史的存取。
 *
 * 有数据库时落库(跨重启保留); 没数据库时退化到**进程内存** —— 功能照样能用, 只是重启会遗忘,
 * 出图时会在页脚标注这一点。
 */

/** 内存兜底: key = `${server}|${eventId}` -> (musicId|tier -> bucket -> score) */
const memory = new Map<string, Map<string, Map<number, number>>>();

/**
 * 数据库**实际**是否在用: 配了 URI 但连不上/写失败时会置为 false ——
 * 出图的页脚据此标注「其实存在内存里」, 不能只看配置。
 */
let dbHealthy = true;

/**
 * 采样时刻归档到桶里: 同一桶内的多次采样只留一条(后到的覆盖先到的)。
 * 桶粒度默认一小时(CUTOFF_BUCKET_S), 自检时调小可以快速攒出多点折线。
 */
export function hourBucket(at: number = Date.now()): number {
    const size = Math.max(1, config.cutoffBucketS) * 1000;
    return Math.floor(at / size) * size;
}

function memSeries(server: Server, eventId: number): Map<string, Map<number, number>> {
    const key = `${server}|${eventId}`;
    let m = memory.get(key);
    if (!m) {
        m = new Map();
        memory.set(key, m);
    }
    return m;
}

/** 写入一批采样(数据库 upsert / 内存覆盖) */
export async function recordCutoffs(server: Server, eventId: number, samples: CutoffSample[]): Promise<void> {
    if (samples.length === 0) return;

    if (dbConfigured()) {
        try {
            const col = await cutoffsCollection();
            if (col) {
                await col.bulkWrite(samples.map(s => ({
                    updateOne: {
                        filter: { server, eventId, musicId: s.musicId, tier: s.tier, bucket: s.bucket },
                        update: { $set: { score: s.score } as Partial<CutoffDoc> },
                        upsert: true
                    }
                })), { ordered: false });
                dbHealthy = true;
                return;
            }
        } catch (e) {
            dbHealthy = false;
            logger('cutoff', `db write failed, fall back to memory: ${e instanceof Error ? e.message : e}`);
        }
    }

    const series = memSeries(server, eventId);
    for (const s of samples) {
        const key = `${s.musicId}|${s.tier}`;
        let byBucket = series.get(key);
        if (!byBucket) {
            byBucket = new Map();
            series.set(key, byBucket);
        }
        byBucket.set(s.bucket, s.score);
    }
}

/**
 * 读取某活动已记录的榜线序列(按曲目 + 档位分组, 时间升序)。
 * @param tiers 只取这些档位(省略 = 全部)
 */
export async function loadCutoffs(server: Server, eventId: number, tiers?: CutoffTier[]): Promise<CutoffSeries[]> {
    const wanted = tiers ? new Set<number>(tiers) : undefined;
    const grouped = new Map<string, CutoffSeries>();

    const push = (doc: CutoffDoc): void => {
        if (wanted && !wanted.has(Number(doc.tier))) return;
        const key = `${doc.musicId}|${doc.tier}`;
        let s = grouped.get(key);
        if (!s) {
            s = { musicId: Number(doc.musicId), tier: Number(doc.tier) as CutoffTier, points: [] };
            grouped.set(key, s);
        }
        s.points.push({ at: Number(doc.bucket), score: Number(doc.score) });
    };

    if (dbConfigured()) {
        try {
            const col = await cutoffsCollection();
            if (col) {
                const docs = await col.find({ server, eventId }).toArray();
                dbHealthy = true;
                for (const d of docs) push(d as CutoffDoc);
                return sortSeries([...grouped.values()]);
            }
        } catch (e) {
            dbHealthy = false;
            logger('cutoff', `db read failed, fall back to memory: ${e instanceof Error ? e.message : e}`);
        }
    }

    for (const [key, byBucket] of memSeries(server, eventId)) {
        const [musicId, tier] = key.split('|');
        for (const [bucket, score] of byBucket) {
            push({ server, eventId, musicId: Number(musicId), tier: Number(tier), bucket, score });
        }
    }
    return sortSeries([...grouped.values()]);
}

function sortSeries(series: CutoffSeries[]): CutoffSeries[] {
    for (const s of series) s.points.sort((a, b) => a.at - b.at);
    series.sort((a, b) => a.musicId - b.musicId || a.tier - b.tier);
    return series;
}

/** 当前是否**真的**存在数据库里(配置了且最近一次读写没失败); 出图据此标注 */
export function cutoffPersistent(): boolean {
    return dbConfigured() && dbHealthy;
}

export const cutoffRecordIntervalS = (): number => config.cutoffRecordIntervalS;
