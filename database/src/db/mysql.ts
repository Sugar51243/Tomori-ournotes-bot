import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger, describeError } from '../logger';

/**
 * MySQL 连接池 —— 全系统唯一一处。搬到本服务前分布在 bot 的
 * src/db/cutoff/mysql.ts 与 web 的 web/server/src/db/mysql.ts 两处。
 *
 * 保留 web 版的全部既有行为:
 * - 库不存在时自动 `CREATE DATABASE IF NOT EXISTS`(**只建库, 不建用户**; 无权限给出可执行的提示)
 * - 每条连接把会话时区钉死在 UTC(见下面 pinUtcTimezone 的坑注释)
 * - 首用建立连接池、失败不缓存, 下次请求会重试(这样"先起本服务后起 MySQL"也能自愈)
 *
 * bot 的库里只有 cutoff 两张表, 查询一律用 `库名.表名` 限定(见各 repo 的 botTable())。
 */

/** CREATE DATABASE 的库名只能白名单校验后回填标识符(不能参数化), 并排除系统库 */
const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

export function isValidDatabaseName(name: string): boolean {
    return /^[A-Za-z0-9_$]{1,64}$/.test(name) && !SYSTEM_SCHEMAS.has(name.toLowerCase());
}

let pool: mysql.Pool | undefined;
let opening: Promise<mysql.Pool> | undefined;
/** 上次失败原因, 供 /api/health 展示 */
let lastError: string | undefined;

function baseOptions(): mysql.PoolOptions {
    const { host, port, user, password, connectTimeoutMs } = config.mysql;
    return {
        host,
        port,
        user: user || 'root',
        password,
        waitForConnections: true,
        connectionLimit: 8,
        maxIdle: 4,
        queueLimit: 0,
        connectTimeout: connectTimeoutMs,
        charset: 'utf8mb4_unicode_ci',
        // DATETIME 一律按 UTC 往返。必须和下面那句 SET time_zone 配套:
        // 只设 timezone 而不管会话时区, CURRENT_TIMESTAMP 仍写服务器本地时间,
        // Node 却按 UTC 解析 —— 时间会整整偏一个时区。
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: false,
    };
}

/**
 * 每条新连接都把会话时区钉死在 UTC。
 *
 * 注意这里的坑: mysql2 的 promise Pool 把 `connection` 事件原样转发给底层**核心**连接池,
 * 所以回调拿到的是回调式的 PoolConnection, 不是 promise 包装过的那个。
 * 写成 conn.query(...).catch() 会在运行时抛「tried to call .then() on ...」,
 * 而且 SQL 根本没发出去 —— 时区设置静默失效, 时间戳整体偏移一个时区。
 * 类型定义在这里是错的(它声明成 promise 版), 所以只能显式断言 + 用回调式接口。
 */
interface CoreConnection {
    query(sql: string, cb: (err: Error | null) => void): void;
}

function pinUtcTimezone(pool: mysql.Pool): mysql.Pool {
    pool.on('connection', raw => {
        const conn = raw as unknown as CoreConnection;
        conn.query("SET time_zone = '+00:00'", err => {
            if (err) logger('mysql', `会话时区设置失败, 时间戳可能偏移: ${describeError(err)}`, 'warn');
        });
    });
    return pool;
}

/** 平台库不存在时自动建库(只建库, 不建用户); 权限不足则给出可执行的 GRANT 提示 */
async function openPool(): Promise<mysql.Pool> {
    const dbName = config.mysql.database;
    if (!isValidDatabaseName(dbName)) {
        throw new Error(`MYSQL_DATABASE 不是合法的库名: ${dbName}`);
    }

    // 先直接连目标库, 正常路径一次到位
    const direct = pinUtcTimezone(mysql.createPool({ ...baseOptions(), database: dbName }));
    try {
        await direct.query('SELECT 1');
        return direct;
    } catch (e) {
        await direct.end().catch(() => undefined);
        const err = e as { code?: string; errno?: number };
        const badDb = err.code === 'ER_BAD_DB_ERROR' || err.errno === 1049;
        if (!badDb) throw e;
    }

    // 库不存在: 不带库名连上去建
    const admin = await mysql.createConnection(baseOptions());
    try {
        await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        logger('mysql', `database "${dbName}" created`);
    } catch (e) {
        throw new Error(
            `库 ${dbName} 不存在且当前账号无权创建。请用管理员账号执行一次:\n` +
                `  CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n` +
                `  GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${config.mysql.user || 'root'}'@'127.0.0.1';\n` +
                `  FLUSH PRIVILEGES;\n` +
                `原始错误: ${describeError(e)}`
        );
    } finally {
        await admin.end().catch(() => undefined);
    }

    const retry = pinUtcTimezone(mysql.createPool({ ...baseOptions(), database: dbName }));
    await retry.query('SELECT 1');
    return retry;
}

/**
 * 取连接池。首次调用建立, 失败后下次请求会重试(不缓存失败),
 * 这样"先起本服务后起 MySQL"也能自愈。
 */
export async function getPool(): Promise<mysql.Pool> {
    if (pool) return pool;
    opening ??= openPool()
        .then(p => {
            pool = p;
            lastError = undefined;
            logger('mysql', `connected: ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
            return p;
        })
        .catch(e => {
            lastError = describeError(e);
            opening = undefined; // 允许下次重试
            throw e;
        });
    return opening;
}

/** 查询助手; 失败原样抛出, 由调用方决定是 503 还是继续 */
export async function query<T = mysql.RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
    const p = await getPool();
    const [rows] = await p.query(sql, params);
    return rows as T;
}

/** 取一行(取不到返回 undefined) */
export async function queryOne<T = mysql.RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await query<T[]>(sql, params);
    return rows[0];
}

/** 写操作, 返回 insertId / affectedRows */
export async function execute(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
    const p = await getPool();
    const [result] = await p.query(sql, params);
    return result as mysql.ResultSetHeader;
}

/** 在事务里跑一组操作(点赞计数、删帖连带计数、发帖带谱这类需要原子性的地方用) */
export async function withTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const p = await getPool();
    const conn = await p.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (e) {
        await conn.rollback().catch(() => undefined);
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * 启动时确保 bot 的库存在(原来由 bot 的 mysql.ts 在连接失败时顺手建)。
 * 建不了只记日志 —— 后续 cutoffSchema 的 DDL 会给出真实错误; 也允许"库稍后由人工建好"。
 */
export async function ensureBotDatabase(): Promise<void> {
    const dbName = config.mysql.botDatabase;
    if (!isValidDatabaseName(dbName)) {
        logger('mysql', `MYSQL_BOT_DATABASE 不是合法的库名: ${dbName}`, 'warn');
        return;
    }
    try {
        const admin = await mysql.createConnection(baseOptions());
        try {
            await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4`);
        } finally {
            await admin.end().catch(() => undefined);
        }
    } catch (e) {
        logger('mysql', `bot 库 "${dbName}" 确保存在失败(可能已存在或无权限): ${describeError(e)}`, 'warn');
    }
}

export interface DbStatus {
    ok: boolean;
    database: string;
    botDatabase: string;
    error?: string;
}

/** 供 /api/health 用的无损探测(不抛错) */
export async function mysqlStatus(): Promise<DbStatus> {
    const base = { database: config.mysql.database, botDatabase: config.mysql.botDatabase };
    try {
        await getPool();
        return { ok: true, ...base };
    } catch (e) {
        return { ok: false, ...base, error: lastError ?? describeError(e) };
    }
}

export async function closeMysql(): Promise<void> {
    const p = pool;
    pool = undefined;
    opening = undefined;
    await p?.end().catch(() => undefined);
}
