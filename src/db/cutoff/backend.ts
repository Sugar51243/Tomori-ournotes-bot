import { CutoffSample } from '../../features/types/Cutoff';

/**
 * 榜线存储后端的公共契约。
 *
 * 行形状与 SQL 表 / 内存结构一一对应; 唯一的身份键是
 * (server, eventId, musicId, tier, bucket) —— 同一整点桶内的重复采样互相覆盖。
 */

export interface CutoffRow {
    server: string;
    eventId: number;
    musicId: number;
    tier: number;
    bucket: number;
    score: number;
    recordedAt?: number;
    upstreamAt?: number;
    /** 实际供数源(回退链档案名); 老数据/旧库为 undefined */
    origin?: string;
}

/**
 * record: 实时采样写入(无条件覆盖, 与旧 Mongo 的 $set 语义一致);
 * merge: 迁移/回灌(只在 incoming 的 recordedAt 不旧于已存值时覆盖, 幂等且不会用旧数据冲掉新数据)。
 */
export type UpsertMode = 'record' | 'merge';

export interface CutoffBackend {
    /** remote = 数据库 API(见 src/db/cutoff/remote.ts); sqlite = 本地缓冲; memory = 进程内存兜底 */
    readonly kind: 'remote' | 'sqlite' | 'memory';
    /** 是否真持久化(内存后端 = false); 出图页脚据此标注 */
    readonly persistent: boolean;
    upsertRows(rows: CutoffRow[], mode: UpsertMode): Promise<void>;
    load(server: string, eventId: number): Promise<CutoffRow[]>;
    /** 全量流式扫描(分批产出; 迁移与回灌用) */
    scanAll(): AsyncIterable<CutoffRow[]>;
    getMeta(key: string): Promise<string | undefined>;
    setMeta(key: string, value: string): Promise<void>;
    ping?(): Promise<void>;
    close?(): Promise<void>;
}

/** 采样点 → 存储行(补上 server/eventId 两列) */
export function sampleToRow(server: string, eventId: number, s: CutoffSample): CutoffRow {
    return {
        server,
        eventId,
        musicId: s.musicId,
        tier: s.tier,
        bucket: s.bucket,
        score: s.score,
        recordedAt: s.recordedAt,
        upstreamAt: s.upstreamAt,
        origin: s.origin
    };
}

/**
 * 清洗一行: 关键字段非法(缺 server / 非数字 id / 非整数 tier / 非有限 score)直接丢弃;
 * 时间戳非有限值归 undefined(落库为 NULL, 读回时不会被 Number(null)=0 画成 1970)。
 */
export function sanitizeRow(row: CutoffRow): CutoffRow | undefined {
    const server = typeof row.server === 'string' ? row.server.trim() : '';
    if (!server || server.length > 16) return undefined;
    const eventId = Number(row.eventId);
    const musicId = Number(row.musicId);
    const tier = Number(row.tier);
    const bucket = Number(row.bucket);
    const score = Number(row.score);
    if (!Number.isFinite(eventId) || !Number.isFinite(musicId) || !Number.isInteger(tier)
        || !Number.isFinite(bucket) || !Number.isFinite(score)) {
        return undefined;
    }
    const out: CutoffRow = { server, eventId, musicId, tier, bucket, score };
    const rec = Number(row.recordedAt);
    if (Number.isFinite(rec)) out.recordedAt = rec;
    const up = Number(row.upstreamAt);
    if (Number.isFinite(up)) out.upstreamAt = up;
    const origin = typeof row.origin === 'string' ? row.origin.trim() : '';
    if (origin && origin.length <= 64) out.origin = origin;
    return out;
}

/** 行身份键(批内去重用) */
export function rowKey(row: CutoffRow): string {
    return `${row.server}|${row.eventId}|${row.musicId}|${row.tier}|${row.bucket}`;
}

/** meta 表键: MongoDB 旧数据已迁移完成(marker 记在当前后端里) */
export const MONGO_MIGRATION_KEY = 'mongo_cutoffs_migrated_v1';
/** meta 表键: SQLite 缓冲里有未回灌 MySQL 的数据 */
export const SQLITE_PENDING_KEY = 'sqlite_pending_sync';

interface MemoryPoint {
    score: number;
    recordedAt?: number;
    upstreamAt?: number;
    origin?: string;
}

/**
 * 进程内存兜底(MySQL 与 SQLite 都不可用时):
 * 功能照样能用, 只是重启会遗忘 —— 与迁移前的内存兜底行为逐字保持一致。
 * key = `${server}|${eventId}` -> (musicId|tier -> bucket -> 采样)
 */
export function createMemoryBackend(): CutoffBackend {
    const memory = new Map<string, Map<string, Map<number, MemoryPoint>>>();
    const meta = new Map<string, string>();

    const seriesFor = (key: string): Map<string, Map<number, MemoryPoint>> => {
        let m = memory.get(key);
        if (!m) {
            m = new Map();
            memory.set(key, m);
        }
        return m;
    };

    return {
        kind: 'memory',
        persistent: false,
        async upsertRows(rows, mode) {
            for (const row of rows) {
                const series = seriesFor(`${row.server}|${row.eventId}`);
                const key = `${row.musicId}|${row.tier}`;
                let byBucket = series.get(key);
                if (!byBucket) {
                    byBucket = new Map();
                    series.set(key, byBucket);
                }
                const prev = byBucket.get(row.bucket);
                if (mode === 'merge' && prev && (row.recordedAt ?? 0) < (prev.recordedAt ?? 0)) continue;
                byBucket.set(row.bucket, {
                    score: row.score,
                    recordedAt: row.recordedAt,
                    // upstreamAt 只在有限值时替换, 否则保留本桶已有的上游时间(与旧逻辑一致)
                    upstreamAt: Number.isFinite(row.upstreamAt) ? row.upstreamAt : prev?.upstreamAt,
                    // origin 同理: 只有给了值才替换本桶已有的来源
                    origin: row.origin ?? prev?.origin
                });
            }
        },
        async load(server, eventId) {
            const series = memory.get(`${server}|${eventId}`);
            const out: CutoffRow[] = [];
            if (!series) return out;
            for (const [key, byBucket] of series) {
                const [musicId, tier] = key.split('|');
                for (const [bucket, p] of byBucket) {
                    out.push({
                        server, eventId, musicId: Number(musicId), tier: Number(tier), bucket,
                        score: p.score, recordedAt: p.recordedAt, upstreamAt: p.upstreamAt, origin: p.origin
                    });
                }
            }
            return out;
        },
        async *scanAll() {
            for (const [key, series] of memory) {
                const [server, eventId] = key.split('|');
                const rows: CutoffRow[] = [];
                for (const [mk, byBucket] of series) {
                    const [musicId, tier] = mk.split('|');
                    for (const [bucket, p] of byBucket) {
                        rows.push({
                            server, eventId: Number(eventId), musicId: Number(musicId), tier: Number(tier), bucket,
                            score: p.score, recordedAt: p.recordedAt, upstreamAt: p.upstreamAt, origin: p.origin
                        });
                    }
                }
                yield rows;
            }
        },
        async getMeta(key) {
            return meta.get(key);
        },
        async setMeta(key, value) {
            meta.set(key, value);
        }
    };
}
