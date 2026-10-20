import { RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { logger, describeError } from '../logger';
import { execute, query, ensureBotDatabase, isValidDatabaseName } from './mysql';

/**
 * 榜线表的建表脚本(原 bot 的 src/db/cutoff/mysql.ts 内的 DDL, 整体搬来)。
 * 库是 bot 的库(MYSQL_BOT_DATABASE), 一律用 `库名.表名` 限定。
 *
 * 遗留兼容: 老库的 cutoff_samples 没有 origin 列(CREATE TABLE IF NOT EXISTS
 * 不会补列), 就地补一列; 列已存在(新库)会报 duplicate column —— 预期路径, 忽略。
 */

/** 库名必须是合法标识符才能回填(不能参数化); 非法值直接抛, 不给注入留缝 */
function botTable(name: string): string {
    if (!isValidDatabaseName(config.mysql.botDatabase)) {
        throw new Error(`MYSQL_BOT_DATABASE 不是合法的库名: ${config.mysql.botDatabase}`);
    }
    return `\`${config.mysql.botDatabase}\`.\`${name}\``;
}

function ddl(): string[] {
    const samples = botTable('cutoff_samples');
    const meta = botTable('cutoff_meta');
    return [
        `CREATE TABLE IF NOT EXISTS ${samples} (
            server      VARCHAR(16) NOT NULL,
            event_id    BIGINT      NOT NULL,
            music_id    BIGINT      NOT NULL,
            tier        INT         NOT NULL,
            bucket      BIGINT      NOT NULL,
            score       DOUBLE      NOT NULL,
            recorded_at BIGINT      NULL,
            upstream_at BIGINT      NULL,
            origin      VARCHAR(64) NULL,
            PRIMARY KEY (server, event_id, music_id, tier, bucket)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
        `CREATE TABLE IF NOT EXISTS ${meta} (
            k VARCHAR(64)  NOT NULL PRIMARY KEY,
            v VARCHAR(255) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    ];
}

/**
 * 老坑自愈: 某些历史部署的 bot 库里 cutoff_meta 是**另一种设计**
 * (server/event_id/storage/updated_at), 与当前 (k,v) 同名不同构 ——
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作, 于是 meta 读写会一直
 * 报 ER_BAD_FIELD_ERROR, bot 的迁移 marker/脏标记静默失效。
 * 处理: 旧表改名保留(数据不动, 代码无任何引用), 把名字让给新结构。
 */
async function healLegacyMeta(): Promise<void> {
    const db = config.mysql.botDatabase;
    const exists = await query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema = ? AND table_name = 'cutoff_meta'`,
        [db]
    );
    if (Number(exists[0]?.n ?? 0) === 0) return;
    const hasK = await query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = ? AND table_name = 'cutoff_meta' AND column_name = 'k'`,
        [db]
    );
    if (Number(hasK[0]?.n ?? 0) > 0) return;

    let target = 'cutoff_meta_legacy_v1';
    try {
        await execute(`RENAME TABLE ${botTable('cutoff_meta')} TO ${botTable(target)}`);
    } catch {
        // 目标名已被占(例如上次改名成功、建表失败): 换带时间戳的名字
        target = `cutoff_meta_legacy_v1_${Date.now()}`;
        await execute(`RENAME TABLE ${botTable('cutoff_meta')} TO ${botTable(target)}`);
    }
    logger('schema', `legacy cutoff_meta renamed to ${target} (旧结构与 (k,v) 冲突; 数据保留)`);
}

/** 幂等建表; 失败抛出(启动流程据此报错, 请求路径不受影响 —— 表已存在时是空操作) */
export async function ensureCutoffSchema(): Promise<void> {
    await ensureBotDatabase();
    await healLegacyMeta();
    for (const sql of ddl()) await execute(sql);
    try {
        await execute(`ALTER TABLE ${botTable('cutoff_samples')} ADD COLUMN origin VARCHAR(64) NULL`);
        logger('schema', 'migrated: added cutoff_samples.origin');
    } catch {
        /* 列已存在 */
    }
}

/** 供启动流程使用: 失败只记日志, 不阻塞服务(请求时会以 DB 错误如实反馈) */
export async function ensureCutoffSchemaSafe(): Promise<void> {
    try {
        await ensureCutoffSchema();
        logger('schema', 'cutoff schema ready (2 tables)');
    } catch (e) {
        logger('schema', `cutoff schema init failed (将在请求时重试): ${describeError(e)}`, 'warn');
    }
}
