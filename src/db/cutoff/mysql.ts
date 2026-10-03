import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import { logger } from '../../logger';
import { CutoffBackend, CutoffRow, UpsertMode, sanitizeRow } from './backend';

/**
 * MySQL 榜线后端(首选存储)。登录信息全部来自 config 的 MYSQL_* 键。
 *
 * - 库不存在时自动 `CREATE DATABASE IF NOT EXISTS`(**只建库, 不建用户**; 无权限则按失败回退)
 * - 任何连接/建表失败都返回 undefined, 由上层回退 SQLite
 */

export interface MysqlOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectTimeoutMs: number;
}

/** CREATE DATABASE 的标识符只能白名单校验后回填(不能参数化), 并排除系统库 */
const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

/** CREATE DATABASE 的库名白名单校验(标识符只能回填不能参数化, 且排除系统库) */
export function isValidDatabaseName(name: string): boolean {
    return /^[A-Za-z0-9_$]{1,64}$/.test(name) && !SYSTEM_SCHEMAS.has(name.toLowerCase());
}

function describe(e: unknown): string {
    const err = e as { code?: string; errno?: number; message?: string };
    const msg = err?.message ?? String(e);
    return err?.code ? `${msg} (${err.code})` : msg;
}

const DDL_SAMPLES = `CREATE TABLE IF NOT EXISTS cutoff_samples (
    server      VARCHAR(16) NOT NULL,
    event_id    BIGINT      NOT NULL,
    music_id    BIGINT      NOT NULL,
    tier        INT         NOT NULL,
    bucket      BIGINT      NOT NULL,
    score       DOUBLE      NOT NULL,
    recorded_at BIGINT      NULL,
    upstream_at BIGINT      NULL,
    PRIMARY KEY (server, event_id, music_id, tier, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

const DDL_META = `CREATE TABLE IF NOT EXISTS cutoff_meta (
    k VARCHAR(64)  NOT NULL PRIMARY KEY,
    v VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

const SELECT_COLUMNS = 'server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at';

const INSERT_COLUMNS = '(server, event_id, music_id, tier, bucket, score, recorded_at, upstream_at)';

const UPSERT_RECORD = `INSERT INTO cutoff_samples ${INSERT_COLUMNS} VALUES ?
ON DUPLICATE KEY UPDATE
    score       = VALUES(score),
    recorded_at = VALUES(recorded_at),
    upstream_at = COALESCE(VALUES(upstream_at), upstream_at)`;

/**
 * merge: 只在 incoming 的 recorded_at 不旧于已存值时覆盖。
 * ODKU 的赋值从左到右可见, recorded_at 放最后、用旧值做守卫, 保证不会被旧数据冲掉。
 */
const UPSERT_MERGE = `INSERT INTO cutoff_samples ${INSERT_COLUMNS} VALUES ?
ON DUPLICATE KEY UPDATE
    score       = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0), VALUES(score), score),
    upstream_at = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0),
                      COALESCE(VALUES(upstream_at), upstream_at), upstream_at),
    recorded_at = IF(IFNULL(VALUES(recorded_at), 0) >= IFNULL(recorded_at, 0), VALUES(recorded_at), recorded_at)`;

const BATCH = 500;
const SCAN_BATCH = 1000;

function toTuple(row: CutoffRow): Array<string | number | null> {
    return [
        row.server, row.eventId, row.musicId, row.tier, row.bucket, row.score,
        row.recordedAt ?? null, row.upstreamAt ?? null
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
    return out;
}

/**
 * 打开 MySQL 榜线后端: 连不上/无权限返回 undefined(由上层回退 SQLite)。
 * 库不存在(1049)且名字合法时自动 CREATE DATABASE IF NOT EXISTS(只建库, 不建用户)。
 * @param opts 连接信息(host/port/user/password/database/超时)
 */
export async function tryOpenMysqlBackend(opts: MysqlOptions): Promise<CutoffBackend | undefined> {
    const connection = {
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        connectTimeout: opts.connectTimeoutMs,
        charset: 'utf8mb4'
    };
    const poolOptions = {
        ...connection,
        waitForConnections: true,
        connectionLimit: 4,
        maxIdle: 4,
        idleTimeout: 60_000,
        queueLimit: 0,
        supportBigNumbers: true,
        bigNumberStrings: false,
        enableKeepAlive: true
    };

    let pool: Pool | undefined;
    try {
        pool = mysql.createPool({ ...poolOptions, database: opts.database });
        await pool.query('SELECT 1');
    } catch (e) {
        const badDb = (e as { code?: string; errno?: number }).code === 'ER_BAD_DB_ERROR'
            || (e as { errno?: number }).errno === 1049;
        await pool?.end().catch(() => undefined);
        pool = undefined;
        if (!badDb) {
            logger('cutoff', `mysql unavailable, fall back to sqlite: ${describe(e)}`);
            return undefined;
        }
        // 库不存在: 尝试自动建库(只建库, 不建用户)
        if (!isValidDatabaseName(opts.database)) {
            logger('cutoff', `mysql database "${opts.database}" does not exist and the name is not creatable`);
            return undefined;
        }
        try {
            const admin = await mysql.createConnection(connection);
            try {
                await admin.query(`CREATE DATABASE IF NOT EXISTS \`${opts.database}\` DEFAULT CHARACTER SET utf8mb4`);
                logger('cutoff', `mysql database "${opts.database}" created`);
            } finally {
                await admin.end().catch(() => undefined);
            }
            pool = mysql.createPool({ ...poolOptions, database: opts.database });
            await pool.query('SELECT 1');
        } catch (e2) {
            logger('cutoff', `mysql database create/retry failed, fall back to sqlite: ${describe(e2)}`);
            await pool?.end().catch(() => undefined);
            return undefined;
        }
    }

    try {
        await pool.query(DDL_SAMPLES);
        await pool.query(DDL_META);
    } catch (e) {
        logger('cutoff', `mysql schema init failed, fall back to sqlite: ${describe(e)}`);
        await pool.end().catch(() => undefined);
        return undefined;
    }

    const activePool = pool;
    return {
        kind: 'mysql',
        persistent: true,
        async upsertRows(rows, mode) {
            const clean = rows.map(sanitizeRow).filter((r): r is CutoffRow => r !== undefined);
            for (let i = 0; i < clean.length; i += BATCH) {
                const tuples = clean.slice(i, i + BATCH).map(toTuple);
                // VALUES ? 的数组展开只在 query() 下生效(execute 是预处理协议, 不展开)
                await activePool.query(mode === 'merge' ? UPSERT_MERGE : UPSERT_RECORD, [tuples]);
            }
        },
        async load(server, eventId) {
            const [rows] = await activePool.query<RowDataPacket[]>(
                `SELECT ${SELECT_COLUMNS} FROM cutoff_samples WHERE server = ? AND event_id = ?`,
                [server, eventId]
            );
            return rows.map(toRow);
        },
        async *scanAll() {
            let cursor: [string, number, number, number, number] | undefined;
            for (;;) {
                const [rows] = cursor
                    ? await activePool.query<RowDataPacket[]>(
                        `SELECT ${SELECT_COLUMNS} FROM cutoff_samples WHERE (server, event_id, music_id, tier, bucket) > (?, ?, ?, ?, ?) ORDER BY server, event_id, music_id, tier, bucket LIMIT ${SCAN_BATCH}`,
                        cursor
                    )
                    : await activePool.query<RowDataPacket[]>(
                        `SELECT ${SELECT_COLUMNS} FROM cutoff_samples ORDER BY server, event_id, music_id, tier, bucket LIMIT ${SCAN_BATCH}`
                    );
                if (!rows.length) return;
                yield rows.map(toRow);
                const last = toRow(rows[rows.length - 1]);
                cursor = [last.server, last.eventId, last.musicId, last.tier, last.bucket];
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        },
        async getMeta(key) {
            const [rows] = await activePool.query<RowDataPacket[]>('SELECT v FROM cutoff_meta WHERE k = ?', [key]);
            return rows[0] ? String(rows[0].v) : undefined;
        },
        async setMeta(key, value) {
            await activePool.query(
                'INSERT INTO cutoff_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
                [key, value]
            );
        },
        async ping() {
            await activePool.query('SELECT 1');
        },
        async close() {
            await activePool.end();
        }
    };
}
