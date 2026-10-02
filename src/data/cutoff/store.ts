import { config } from '../../config';
import { logger } from '../../logger';
import { Server } from '../../types/Server';
import { CutoffDoc, CutoffMeta, CutoffSample, CutoffSeries, CutoffTier } from '../../types/Cutoff';
import { cutoffsCollection, dbConfigured } from '../mongo';

/**
 * 榜线历史的存取。
 *
 * 有数据库时落库(跨重启保留); 没数据库时退化到**进程内存** —— 功能照样能用, 只是重启会遗忘,
 * 出图时会在页脚标注这一点。
 */

/** 内存里的一条采样(与数据库文档同形, 便于两条路径读出同一份 meta) */
interface MemoryPoint {
    score: number;
    recordedAt?: number;
    upstreamAt?: number;
}

/** 内存兜底: key = `${server}|${eventId}` -> (musicId|tier -> bucket -> 采样) */
const memory = new Map<string, Map<string, Map<number, MemoryPoint>>>();

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

function memSeries(server: Server, eventId: number): Map<string, Map<number, MemoryPoint>> {
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
                await col.bulkWrite(samples.map(s => {
                    // upstreamAt 只在有限值时写入: Mongo 驱动会把 undefined 存成 null,
                    // 读回 Number(null)=0 会画成 1970; 本桶缺 etag 时也保留已有的上游时间
                    const set: Partial<CutoffDoc> = { score: s.score, recordedAt: s.recordedAt };
                    if (Number.isFinite(s.upstreamAt)) set.upstreamAt = s.upstreamAt;
                    return {
                        updateOne: {
                            filter: { server, eventId, musicId: s.musicId, tier: s.tier, bucket: s.bucket },
                            update: { $set: set },
                            upsert: true
                        }
                    };
                }), { ordered: false });
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
        const prev = byBucket.get(s.bucket);
        byBucket.set(s.bucket, {
            score: s.score,
            recordedAt: s.recordedAt,
            upstreamAt: Number.isFinite(s.upstreamAt) ? s.upstreamAt : prev?.upstreamAt
        });
    }
}

export interface CutoffLoadResult {
    series: CutoffSeries[];
    /** 数据新鲜度: 最近一次本地写入时刻 / 最近一次上游数据更新时间 */
    meta: CutoffMeta;
}

/**
 * 读取某活动已记录的榜线序列(按曲目 + 档位分组, 时间升序), 外加数据新鲜度 meta。
 * meta 统计**全部**文档(不受 tiers 过滤影响), 否则只画某一档时会看不出其它档的新采样。
 * @param tiers 只取这些档位(省略 = 全部)
 */
export async function loadCutoffs(server: Server, eventId: number, tiers?: CutoffTier[]): Promise<CutoffLoadResult> {
    const wanted = tiers ? new Set<number>(tiers) : undefined;
    const grouped = new Map<string, CutoffSeries>();
    let lastRecordedAt: number | undefined;
    let lastUpstreamAt: number | undefined;

    const noteMeta = (doc: CutoffDoc): void => {
        const rec = Number(doc.recordedAt);
        if (Number.isFinite(rec) && rec > 0 && (lastRecordedAt === undefined || rec > lastRecordedAt)) lastRecordedAt = rec;
        const up = Number(doc.upstreamAt);
        if (Number.isFinite(up) && up > 0 && (lastUpstreamAt === undefined || up > lastUpstreamAt)) lastUpstreamAt = up;
    };

    const push = (doc: CutoffDoc): void => {
        noteMeta(doc);
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
                return { series: sortSeries([...grouped.values()]), meta: { lastRecordedAt, lastUpstreamAt } };
            }
        } catch (e) {
            dbHealthy = false;
            logger('cutoff', `db read failed, fall back to memory: ${e instanceof Error ? e.message : e}`);
        }
    }

    for (const [key, byBucket] of memSeries(server, eventId)) {
        const [musicId, tier] = key.split('|');
        for (const [bucket, p] of byBucket) {
            push({
                server, eventId, musicId: Number(musicId), tier: Number(tier), bucket,
                score: p.score, recordedAt: p.recordedAt, upstreamAt: p.upstreamAt
            });
        }
    }
    return { series: sortSeries([...grouped.values()]), meta: { lastRecordedAt, lastUpstreamAt } };
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
