import { RowDataPacket } from 'mysql2/promise';
import { config } from '../../config';
import { query, execute, isValidDatabaseName } from '../mysql';
import { isCutoffTier, type CutoffTier, type Server } from '../../constants';

/**
 * 榜线表(bot 的库)。
 *
 * 写路径整体搬自 bot 的 src/db/cutoff/mysql.ts(ODKU 语句逐字保留):
 *   - record 模式 = 无条件覆盖(与旧 Mongo 的 $set 语义一致);
 *   - merge 模式 = 只在 incoming 的 recorded_at 不旧于已存值时覆盖(迁移/回灌用, 幂等)。
 * 读路径里的 listEvents / series 整体搬自 web 的 cutoffRepo.ts(只读聚合原样保留)。
 */

/** 库名必须是合法标识符才能回填(不能参数化); 非法值直接抛, 不给注入留缝 */
function botTable(name: string): string {
    const db = config.mysql.botDatabase;
    if (!isValidDatabaseName(db)) throw new Error(`MYSQL_BOT_DATABASE 不是合法的库名: ${db}`);
    return `\`${db}\`.${name}`;
}

// ---------------------------------------------------------------- 行格式

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

export type UpsertMode = 'record' | 'merge';

/**
 * 清洗一行(与 bot 的 sanitizeRow 逐字一致): 关键字段非法(缺 server / 非数字 id /
 * 非整数 tier / 非有限 score)直接丢弃; 时间戳非有限值归 undefined(落库为 NULL)。
 */
export function sanitizeRow(raw: unknown): CutoffRow | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const row = raw as Record<string, unknown>;
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

const SELECT_COLUMNS = 'server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at, origin';

const INSERT_COLUMNS = '(server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at, origin)';

const upsertRecordSql = (table: string): string => `INSERT INTO ${table} ${INSERT_COLUMNS} VALUES ?
ON DUPLICATE KEY UPDATE
    score       = VALUES(score),
    recorded_at = VALUES(recorded_at),
    upstream_at = COALESCE(VALUES(upstream_at), upstream_at),
    origin      = COALESCE(VALUES(origin), origin)`;

/**
 * merge: 只在 incoming 的 recorded_at 不旧于已存值时覆盖。
 * ODKU 的赋值从左到右可见, recorded_at 放最后、用旧值做守卫, 保证不会被旧数据冲掉。
 */
const upsertMergeSql = (table: string): string => `INSERT INTO ${table} ${INSERT_COLUMNS} VALUES ?
ON DUPLICATE KEY UPDATE
    score       = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0), VALUES(score), score),
    upstream_at = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0),
                      COALESCE(VALUES(upstream_at), upstream_at), upstream_at),
    origin      = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0),
                      COALESCE(VALUES(origin), origin), origin),
    recorded_at = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0), VALUES(recorded_at), recorded_at)`;

const BATCH = 500;

function toTuple(row: CutoffRow): Array<string | number | null> {
    return [
        row.server, row.eventId, row.musicId, row.tier, row.bucket, row.score,
        row.recordedAt ?? null, row.upstreamAt ?? null, row.origin ?? null
    ];
}

/** BIGINT 可能以字符串返回, 统一 Number() 收口; NULL → undefined */
function toRow(raw: RowDataPacket): CutoffRow {
    const out: CutoffRow = {
        server: String(raw.server),
        eventId: Number(raw.event_id),
        musicId: Number(raw.music_id),
        tier: Number(raw.tier),
        bucket: Number(raw.bucket),
        score: Number(raw.score)
    };
    if (raw.recorded_at !== null && raw.recorded_at !== undefined) out.recordedAt = Number(raw.recorded_at);
    if (raw.upstream_at !== null && raw.upstream_at !== undefined) out.upstreamAt = Number(raw.upstream_at);
    if (raw.origin !== null && raw.origin !== undefined) out.origin = String(raw.origin);
    return out;
}

// ---------------------------------------------------------------- 写

/** 批量 upsert(原样搬 bot mysql.ts; VALUES ? 的数组展开只在 query() 下生效) */
export async function upsertRows(rawRows: unknown[], mode: UpsertMode): Promise<{ written: number }> {
    const clean = rawRows.map(sanitizeRow).filter((r): r is CutoffRow => r !== undefined);
    const table = botTable('cutoff_samples');
    const sql = mode === 'merge' ? upsertMergeSql(table) : upsertRecordSql(table);
    for (let i = 0; i < clean.length; i += BATCH) {
        const tuples = clean.slice(i, i + BATCH).map(toTuple);
        await query(sql, [tuples]);
    }
    return { written: clean.length };
}

// ---------------------------------------------------------------- 读(bot 侧)

/** 某活动的全部采样行 */
export async function load(server: string, eventId: number): Promise<CutoffRow[]> {
    const rows = await query<RowDataPacket[]>(
        `SELECT ${SELECT_COLUMNS} FROM ${botTable('cutoff_samples')} WHERE server = ? AND event_id = ?`,
        [server, eventId]
    );
    return rows.map(toRow);
}

export interface ScanPage {
    rows: CutoffRow[];
    /** 下一页游标; null = 已取完 */
    next: [string, number, number, number, number] | null;
}

/** 全量流式扫描的一页(迁移与回灌用); 按五列主键游标分页 */
export async function scan(after: [string, number, number, number, number] | undefined, limit: number): Promise<ScanPage> {
    const table = botTable('cutoff_samples');
    const rows = after
        ? await query<RowDataPacket[]>(
            `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE (server, event_id, music_id, tier, bucket) > (?, ?, ?, ?, ?) ORDER BY server, event_id, music_id, tier, bucket LIMIT ${limit}`,
            after
        )
        : await query<RowDataPacket[]>(
            `SELECT ${SELECT_COLUMNS} FROM ${table} ORDER BY server, event_id, music_id, tier, bucket LIMIT ${limit}`
        );
    const mapped = rows.map(toRow);
    const last = mapped[mapped.length - 1];
    return {
        rows: mapped,
        next: rows.length < limit || !last ? null : [last.server, last.eventId, last.musicId, last.tier, last.bucket]
    };
}

/** meta 表读写(bot 的迁移 marker / 脏标记) */
export async function getMeta(key: string): Promise<string | undefined> {
    const rows = await query<RowDataPacket[]>(`SELECT v FROM ${botTable('cutoff_meta')} WHERE k = ?`, [key]);
    return rows[0] ? String(rows[0].v) : undefined;
}

export async function setMeta(key: string, value: string): Promise<void> {
    await execute(
        `INSERT INTO ${botTable('cutoff_meta')} (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`,
        [key, value]
    );
}

/** 连接与表可用性的无损探测 */
export async function ping(): Promise<void> {
    await query('SELECT 1');
}

// ---------------------------------------------------------------- 读(web 侧聚合, 原搬 web 的 cutoffRepo.ts)

export interface CutoffEventSummary {
    eventId: number;
    firstBucket: number;
    lastBucket: number;
    lastRecordedAt?: number;
    lastUpstreamAt?: number;
    musicCount: number;
    /** 该活动实际有采样的档位(上游每曲榜只有前 100 名, 所以通常只有 10/100) */
    tiers: CutoffTier[];
    pointCount: number;
}

interface EventRow {
    event_id: number | string;
    first_bucket: number | string;
    last_bucket: number | string;
    last_recorded_at: number | string | null;
    last_upstream_at: number | string | null;
    music_count: number | string;
    point_count: number | string;
}

/** 有采样记录的活动, 按最近采样时间倒序 */
export async function listCutoffEvents(server: Server, limit = 30): Promise<CutoffEventSummary[]> {
    const rows = await query<EventRow[]>(
        `SELECT event_id,
                MIN(bucket)       AS first_bucket,
                MAX(bucket)       AS last_bucket,
                MAX(recorded_at)  AS last_recorded_at,
                MAX(upstream_at)  AS last_upstream_at,
                COUNT(DISTINCT music_id) AS music_count,
                COUNT(*)          AS point_count
         FROM ${botTable('cutoff_samples')}
         WHERE server = ?
         GROUP BY event_id
         ORDER BY last_bucket DESC
         LIMIT ?`,
        [server, limit]
    );
    if (!rows.length) return [];

    // 档位单独查一次, 免得在主查询里 GROUP_CONCAT 再拆字符串
    const eventIds = rows.map(r => Number(r.event_id));
    const tierRows = await query<Array<{ event_id: number | string; tier: number | string }>>(
        `SELECT DISTINCT event_id, tier FROM ${botTable('cutoff_samples')}
         WHERE server = ? AND event_id IN (${eventIds.map(() => '?').join(',')})
         ORDER BY event_id, tier`,
        [server, ...eventIds]
    );
    const tiersByEvent = new Map<number, CutoffTier[]>();
    for (const r of tierRows) {
        const id = Number(r.event_id);
        const tier = Number(r.tier);
        if (!isCutoffTier(tier)) continue;
        const list = tiersByEvent.get(id) ?? [];
        list.push(tier);
        tiersByEvent.set(id, list);
    }

    return rows.map(r => ({
        eventId: Number(r.event_id),
        firstBucket: Number(r.first_bucket),
        lastBucket: Number(r.last_bucket),
        lastRecordedAt: r.last_recorded_at === null ? undefined : Number(r.last_recorded_at),
        lastUpstreamAt: r.last_upstream_at === null ? undefined : Number(r.last_upstream_at),
        musicCount: Number(r.music_count),
        pointCount: Number(r.point_count),
        tiers: tiersByEvent.get(Number(r.event_id)) ?? [],
    }));
}

interface SampleRow {
    music_id: number | string;
    tier: number | string;
    bucket: number | string;
    score: number | string;
    recorded_at: number | string | null;
    upstream_at: number | string | null;
    origin?: string | null;
}

export interface CutoffSeriesPoint {
    at: number;
    score: number;
    origin?: string;
}

export interface CutoffSeries {
    musicId: number;
    tier: CutoffTier;
    points: CutoffSeriesPoint[];
}

export interface CutoffSeriesResult {
    series: CutoffSeries[];
    lastRecordedAt?: number;
    lastUpstreamAt?: number;
    /** 数据里出现过的档位 */
    tiers: CutoffTier[];
    /** 脏数据(值顶到 int32 极限之类)的点数, 与 bot 出图时的口径一致 */
    outlierCount: number;
    /**
     * 这批采样实际供数的上游(去重, 如 ['bdon.moe'] / ['haneoka.org', 'bdon.moe']) ——
     * bot 逐条记录在 origin 列里(回退链中途换源时会有多家); 老数据没有记录时为空数组。
     */
    origins: string[];
}

/** 单活动的完整折线序列; 返回的点按 musicId → tier → 时间升序 */
export async function loadCutoffSeries(server: Server, eventId: number, tiers?: CutoffTier[]): Promise<CutoffSeriesResult> {
    const where = ['server = ?', 'event_id = ?'];
    const args: unknown[] = [server, eventId];
    if (tiers?.length) {
        where.push(`tier IN (${tiers.map(() => '?').join(',')})`);
        args.push(...tiers);
    }

    const baseSelect = `SELECT music_id, tier, bucket, score, recorded_at, upstream_at`;
    const fromWhere = `FROM ${botTable('cutoff_samples')}
         WHERE ${where.join(' AND ')}
         ORDER BY music_id, tier, bucket`;
    let rows: SampleRow[];
    try {
        rows = await query<SampleRow[]>(`${baseSelect}, origin ${fromWhere}`, args);
    } catch {
        // 老库可能还没有 origin 列 —— 退回不带来源的查询, 不拖垮页面
        rows = await query<SampleRow[]>(`${baseSelect} ${fromWhere}`, args);
    }

    const byKey = new Map<string, CutoffSeries>();
    const tiersSeen = new Set<CutoffTier>();
    const originsSeen = new Set<string>();
    let lastRecordedAt: number | undefined;
    let lastUpstreamAt: number | undefined;
    let outlierCount = 0;

    for (const r of rows) {
        const tier = Number(r.tier);
        if (!isCutoffTier(tier)) continue;
        const musicId = Number(r.music_id);
        const at = Number(r.bucket);
        const score = Number(r.score);

        // 上游偶发的脏数据: 值顶到 int32 极限。画的时候不参与纵轴定标(见前端 chartScale)
        if (!Number.isFinite(score) || score >= 2_147_483_647) outlierCount++;

        const origin = typeof r.origin === 'string' && r.origin ? r.origin : undefined;
        if (origin) originsSeen.add(origin);

        const key = `${musicId}|${tier}`;
        let series = byKey.get(key);
        if (!series) {
            series = { musicId, tier, points: [] };
            byKey.set(key, series);
        }
        series.points.push({ at, score, origin });

        tiersSeen.add(tier);
        const rec = r.recorded_at === null ? undefined : Number(r.recorded_at);
        const up = r.upstream_at === null ? undefined : Number(r.upstream_at);
        if (rec !== undefined && (lastRecordedAt === undefined || rec > lastRecordedAt)) lastRecordedAt = rec;
        if (up !== undefined && (lastUpstreamAt === undefined || up > lastUpstreamAt)) lastUpstreamAt = up;
    }

    return {
        series: [...byKey.values()].sort((a, b) => a.musicId - b.musicId || a.tier - b.tier),
        tiers: [...tiersSeen].sort((a, b) => a - b),
        lastRecordedAt,
        lastUpstreamAt,
        outlierCount,
        origins: [...originsSeen].sort(),
    };
}
