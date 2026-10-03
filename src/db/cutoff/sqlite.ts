import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../../logger';
import { CutoffBackend, CutoffRow, SQLITE_PENDING_KEY, UpsertMode, sanitizeRow } from './backend';

/**
 * SQLite 榜线后端: MySQL 不可用时的回退存储, 同时充当"降级缓冲"
 * (MySQL 恢复后其中的数据会被幂等回灌)。
 *
 * better-sqlite3 是原生模块, 这里做**惰性 try/catch 加载** —— 装不上/加载失败时
 * 优雅返回 undefined, 上层继续退到内存, 不影响进程启动。
 */

type SqliteDb = InstanceType<typeof Database>;

let ctor: typeof Database | undefined;
let ctorTried = false;

function loadCtor(): typeof Database | undefined {
    if (!ctorTried) {
        ctorTried = true;
        try {
            ctor = require('better-sqlite3') as typeof Database;
        } catch (e) {
            logger('cutoff', `better-sqlite3 unavailable, sqlite fallback disabled: ${e instanceof Error ? e.message : e}`);
        }
    }
    return ctor;
}

const DDL_SAMPLES = `CREATE TABLE IF NOT EXISTS cutoff_samples (
    server      TEXT    NOT NULL,
    event_id    INTEGER NOT NULL,
    music_id    INTEGER NOT NULL,
    tier        INTEGER NOT NULL,
    bucket      INTEGER NOT NULL,
    score       REAL    NOT NULL,
    recorded_at INTEGER NULL,
    upstream_at INTEGER NULL,
    PRIMARY KEY (server, event_id, music_id, tier, bucket)
)`;

const DDL_META = `CREATE TABLE IF NOT EXISTS cutoff_meta (
    k TEXT NOT NULL PRIMARY KEY,
    v TEXT NOT NULL
)`;

const SELECT_COLUMNS = 'server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at';

const INSERT_COLUMNS = '(server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at)';

const UPSERT_RECORD = `INSERT INTO cutoff_samples ${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(server, event_id, music_id, tier, bucket) DO UPDATE SET
    score       = excluded.score,
    recorded_at = excluded.recorded_at,
    upstream_at = COALESCE(excluded.upstream_at, upstream_at)`;

/** merge: 只在 incoming 的 recorded_at 不旧于已存值时覆盖(SET 表达式读的都是旧行, 与赋值顺序无关) */
const UPSERT_MERGE = `INSERT INTO cutoff_samples ${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(server, event_id, music_id, tier, bucket) DO UPDATE SET
    score       = CASE WHEN IFNULL(excluded.recorded_at, 0) >= IFNULL(recorded_at, 0) THEN excluded.score ELSE score END,
    upstream_at = CASE WHEN IFNULL(excluded.recorded_at, 0) >= IFNULL(recorded_at, 0)
                       THEN COALESCE(excluded.upstream_at, upstream_at) ELSE upstream_at END,
    recorded_at = CASE WHEN IFNULL(excluded.recorded_at, 0) >= IFNULL(recorded_at, 0) THEN excluded.recorded_at ELSE recorded_at END`;

function toParams(row: CutoffRow): Array<string | number | null> {
    return [
        row.server, row.eventId, row.musicId, row.tier, row.bucket, row.score,
        row.recordedAt ?? null, row.upstreamAt ?? null
    ];
}

const SCAN_BATCH = 1000;

function toRow(raw: Record<string, unknown>): CutoffRow {
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
    return out;
}

/**
 * 打开 SQLite 榜线后端(WAL, 建目录 + 建表)。
 * @param file 数据库文件路径(父目录不存在会自动创建)
 * @returns 打开失败(原生模块缺失/路径不可写)返回 undefined, 由上层退内存
 */
export async function tryOpenSqliteBackend(file: string): Promise<CutoffBackend | undefined> {
    const Ctor = loadCtor();
    if (!Ctor) return undefined;

    let db: SqliteDb;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        db = new Ctor(file);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 5000');
        db.exec(DDL_SAMPLES);
        db.exec(DDL_META);
    } catch (e) {
        logger('cutoff', `sqlite open failed (${file}): ${e instanceof Error ? e.message : e}`);
        return undefined;
    }

    const recordStmt = db.prepare(UPSERT_RECORD);
    const mergeStmt = db.prepare(UPSERT_MERGE);
    const selectStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM cutoff_samples WHERE server = ? AND event_id = ?`);
    const getMetaStmt = db.prepare('SELECT v FROM cutoff_meta WHERE k = ?');
    const setMetaStmt = db.prepare('INSERT INTO cutoff_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

    const scanAllStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM cutoff_samples ORDER BY server, event_id, music_id, tier, bucket LIMIT ${SCAN_BATCH}`);
    const scanAfterStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM cutoff_samples WHERE (server, event_id, music_id, tier, bucket) > (?, ?, ?, ?, ?) ORDER BY server, event_id, music_id, tier, bucket LIMIT ${SCAN_BATCH}`);

    /** 一批写入 + 脏标记同一事务提交(崩溃也不会出现"有数据没标记") */
    const writeBatch = db.transaction((rows: CutoffRow[], mode: UpsertMode, markPending: boolean) => {
        const stmt = mode === 'merge' ? mergeStmt : recordStmt;
        for (const row of rows) stmt.run(...toParams(row));
        if (markPending) setMetaStmt.run(SQLITE_PENDING_KEY, '1');
    });

    return {
        kind: 'sqlite',
        persistent: true,
        async upsertRows(rows, mode) {
            const clean = rows.map(sanitizeRow).filter((r): r is CutoffRow => r !== undefined);
            if (!clean.length) return;
            // 实时写入标记"待回灌"(迁移/回灌本身不标记, 避免自我循环)
            writeBatch(clean, mode, mode === 'record');
        },
        async load(server, eventId) {
            return (selectStmt.all(server, eventId) as Array<Record<string, unknown>>).map(toRow);
        },
        async *scanAll() {
            let cursor: [string, number, number, number, number] | undefined;
            for (;;) {
                const rows = (cursor
                    ? scanAfterStmt.all(...cursor)
                    : scanAllStmt.all()) as Array<Record<string, unknown>>;
                if (!rows.length) return;
                yield rows.map(toRow);
                const last = toRow(rows[rows.length - 1]);
                cursor = [last.server, last.eventId, last.musicId, last.tier, last.bucket];
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        },
        async getMeta(key) {
            const row = getMetaStmt.get(key) as { v?: string } | undefined;
            return row?.v;
        },
        async setMeta(key, value) {
            setMetaStmt.run(key, value);
        },
        async ping() {
            db.prepare('SELECT 1').get();
        },
        async close() {
            db.close();
        }
    };
}
