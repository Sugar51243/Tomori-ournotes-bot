import { config } from '../../config';
import { logger } from '../../logger';
import { Server } from '../../features/types/Server';
import { CutoffMeta, CutoffSample, CutoffSeries, CutoffTier } from '../../features/types/Cutoff';
import { CutoffRow } from './backend';
import { CutoffRuntime } from './runtime';
import { tryOpenMysqlBackend } from './mysql';
import { tryOpenSqliteBackend } from './sqlite';
import { closeMongo, cutoffsForMigration } from '../mongo';

/**
 * 榜线历史的存取。
 *
 * 存储优先级: MySQL(config 的 MYSQL_* 配置且可连; 库不存在会自动创建) → SQLite 文件兜底
 * (MySQL 不可用时写入, 恢复后自动回灌) → 进程内存(前两者都不可用; 重启会遗忘, 出图页脚会标注)。
 * 首次启动会把 MongoDB `cutoffs` 集合里的旧数据只读迁移到当前存储, Mongo 原数据保留不动。
 */

let runtime: CutoffRuntime | undefined;

function getRuntime(): CutoffRuntime {
    runtime ??= new CutoffRuntime({
        log: m => logger('cutoff', m),
        mysqlConfigured: () => !!config.mysqlHost,
        openMysql: () => config.mysqlHost
            ? tryOpenMysqlBackend({
                host: config.mysqlHost,
                port: config.mysqlPort,
                user: config.mysqlUser,
                password: config.mysqlPassword,
                database: config.mysqlDatabase,
                connectTimeoutMs: config.dbConnectTimeoutMs
            })
            : Promise.resolve(undefined),
        openSqlite: () => tryOpenSqliteBackend(config.sqlitePath),
        mongo: config.mongoUri ? {
            iterate: () => cutoffsForMigration(),
            // ENABLE_DB=false(社区功能关)时迁移完就断开; 开着则连接还给社区功能复用
            close: config.enableDb ? async () => undefined : closeMongo
        } : undefined
    });
    return runtime;
}

/** 启动时主动初始化(选择后端 + 后台迁移); 首个读写也会等待同一 promise, 无竞争 */
export function initCutoffStore(): Promise<void> {
    return getRuntime().init();
}

/**
 * 采样时刻归档到桶里: 同一桶内的多次采样只留一条(后到的覆盖先到的)。
 * 桶粒度默认一小时(CUTOFF_BUCKET_S), 自检时调小可以快速攒出多点折线。
 */
export function hourBucket(at: number = Date.now()): number {
    const size = Math.max(1, config.cutoffBucketS) * 1000;
    return Math.floor(at / size) * size;
}

/** 写入一批采样(存储 upsert; 失败降级, 不向调用方抛错) */
export async function recordCutoffs(server: Server, eventId: number, samples: CutoffSample[]): Promise<void> {
    if (samples.length === 0) return;
    await getRuntime().record(server, eventId, samples);
}

export interface CutoffLoadResult {
    series: CutoffSeries[];
    /** 数据新鲜度: 最近一次本地写入时刻 / 最近一次上游数据更新时间 */
    meta: CutoffMeta;
}

/**
 * 读取某活动已记录的榜线序列(按曲目 + 档位分组, 时间升序), 外加数据新鲜度 meta。
 * meta 统计**全部**行(不受 tiers 过滤影响), 否则只画某一档时会看不出其它档的新采样。
 * @param tiers 只取这些档位(省略 = 全部)
 */
export async function loadCutoffs(server: Server, eventId: number, tiers?: CutoffTier[]): Promise<CutoffLoadResult> {
    const wanted = tiers ? new Set<number>(tiers) : undefined;
    const grouped = new Map<string, CutoffSeries>();
    let lastRecordedAt: number | undefined;
    let lastUpstreamAt: number | undefined;

    const noteMeta = (row: CutoffRow): void => {
        const rec = Number(row.recordedAt);
        if (Number.isFinite(rec) && rec > 0 && (lastRecordedAt === undefined || rec > lastRecordedAt)) lastRecordedAt = rec;
        const up = Number(row.upstreamAt);
        if (Number.isFinite(up) && up > 0 && (lastUpstreamAt === undefined || up > lastUpstreamAt)) lastUpstreamAt = up;
    };

    const push = (row: CutoffRow): void => {
        noteMeta(row);
        if (wanted && !wanted.has(Number(row.tier))) return;
        const key = `${row.musicId}|${row.tier}`;
        let s = grouped.get(key);
        if (!s) {
            s = { musicId: Number(row.musicId), tier: Number(row.tier) as CutoffTier, points: [] };
            grouped.set(key, s);
        }
        s.points.push({ at: Number(row.bucket), score: Number(row.score) });
    };

    const rows = await getRuntime().load(server, eventId);
    for (const r of rows) push(r);
    return { series: sortSeries([...grouped.values()]), meta: { lastRecordedAt, lastUpstreamAt } };
}

function sortSeries(series: CutoffSeries[]): CutoffSeries[] {
    for (const s of series) s.points.sort((a, b) => a.at - b.at);
    series.sort((a, b) => a.musicId - b.musicId || a.tier - b.tier);
    return series;
}

/** 当前是否**真的**持久化(MySQL 或 SQLite 后端; 内存兜底为 false); 出图据此标注 */
export function cutoffPersistent(): boolean {
    return runtime ? runtime.persistent() : true;
}

/** 榜线常驻采样间隔(秒, 来自 CUTOFF_RECORD_INTERVAL_S) */
export const cutoffRecordIntervalS = (): number => config.cutoffRecordIntervalS;
