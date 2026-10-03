import { CutoffSample } from '../../features/types/Cutoff';
import {
    CutoffBackend, CutoffRow, MONGO_MIGRATION_KEY, SQLITE_PENDING_KEY,
    UpsertMode, createMemoryBackend, sampleToRow, sanitizeRow
} from './backend';
import { migrateMongoToBackend, syncToMysql } from './migrate';

/**
 * 榜线存储的运行时状态机:
 * - 启动选择后端: MySQL(配了 MYSQL_HOST) → SQLite 文件 → 进程内存
 * - SQLite 始终作为"降级缓冲"打开: MySQL 挂了写它(同一事务里置脏标记),
 *   MySQL 恢复后自动回灌并切回去; 数据不会因一次连接失败而落到内存
 * - MongoDB 旧数据只读迁移一次(marker 记在当前后端里, 失败退避重试)
 * - 巡检 15s 一拍, 后台进行, 不阻塞启动与请求
 */

export interface RuntimeDeps {
    log: (msg: string) => void;
    /** 是否配置了 MySQL(决定要不要持续探测恢复) */
    mysqlConfigured: () => boolean;
    /** 打开 MySQL 后端; 未配置/失败返回 undefined */
    openMysql: () => Promise<CutoffBackend | undefined>;
    /** 打开 SQLite 后端; 原生模块缺失/文件不可写返回 undefined */
    openSqlite: () => Promise<CutoffBackend | undefined>;
    /** Mongo 迁移源; 未配置 MONGODB_URI 时整个字段缺省 */
    mongo?: {
        iterate: () => Promise<AsyncIterable<unknown> | undefined>;
        close: () => Promise<void>;
    };
    /** 失败重试的起始间隔(毫秒; 测试用, 默认 30s, 指数退避到 300s) */
    retryMinMs?: number;
}

const HOUSEKEEP_MS = 15_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 300_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 榜线存储的运行时状态机: 后端选择(MySQL → SQLite 缓冲 → 内存)、故障降级、
 * 恢复回灌、Mongo 旧数据迁移, 以及后台巡检(15s 一拍, 失败指数退避)。
 * @param deps 依赖注入点(存储/日志/重试间隔), 测试可换假实现
 */
export class CutoffRuntime {
    private active: CutoffBackend = createMemoryBackend();
    private sqlite: CutoffBackend | undefined;
    private mysql: CutoffBackend | undefined;
    private initPromise: Promise<void> | undefined;
    /** 写互斥: 实时写入 / 回灌 / 切换后端都串行, 降级期数据不会被同步流漏掉 */
    private writeChain: Promise<unknown> = Promise.resolve();
    private housekeeping = false;
    private timer: NodeJS.Timeout | undefined;
    private nextMysqlAttemptAt = 0;
    private mysqlRetryMs: number;
    private nextSyncAt = 0;
    private nextMongoAttemptAt = 0;
    private mongoRetryMs: number;
    private mongoFinished = false;
    private readonly retryMin: number;

    constructor(private readonly deps: RuntimeDeps) {
        this.retryMin = deps.retryMinMs ?? RETRY_MIN_MS;
        this.mysqlRetryMs = this.retryMin;
        this.mongoRetryMs = this.retryMin;
    }

    init(): Promise<void> {
        this.initPromise ??= this.doInit();
        return this.initPromise;
    }

    /** 是否真持久化(内存后端 = false); 出图页脚据此标注 */
    persistent(): boolean {
        return this.active.kind !== 'memory';
    }

    private async doInit(): Promise<void> {
        this.sqlite = await this.openSafely('sqlite', () => this.deps.openSqlite());
        this.mysql = await this.openSafely('mysql', () => this.deps.openMysql());
        this.active = this.mysql ?? this.sqlite ?? createMemoryBackend();
        this.deps.log(`cutoff store: ${this.active.kind}${!this.mysql && this.deps.mysqlConfigured() ? ' (mysql unavailable, using sqlite buffer)' : ''}`);
        this.timer = setInterval(() => void this.housekeep(), HOUSEKEEP_MS);
        this.timer.unref?.();
        void this.housekeep();
    }

    private async openSafely(what: string, open: () => Promise<CutoffBackend | undefined>): Promise<CutoffBackend | undefined> {
        try {
            return await open();
        } catch (e) {
            this.deps.log(`${what} open failed: ${msg(e)}`);
            return undefined;
        }
    }

    async record(server: string, eventId: number, samples: CutoffSample[]): Promise<void> {
        await this.init();
        const rows = samples
            .map(s => sanitizeRow(sampleToRow(server, eventId, s)))
            .filter((r): r is CutoffRow => r !== undefined);
        if (!rows.length) return;
        await this.writeRows(rows, 'record');
    }

    async load(server: string, eventId: number): Promise<CutoffRow[]> {
        await this.init();
        try {
            return await this.active.load(server, eventId);
        } catch (e) {
            const kind = this.active.kind;
            this.degrade(`read failed on ${kind}: ${msg(e)}`);
            try {
                return await this.active.load(server, eventId);
            } catch (e2) {
                this.deps.log(`cutoff read failed after degrade: ${msg(e2)}`);
                return [];
            }
        }
    }

    /** 与迁移前一致: 写路径永不向调用方抛错(失败降级并记日志) */
    private async writeRows(rows: CutoffRow[], mode: UpsertMode): Promise<void> {
        try {
            await this.runExclusive(async () => {
                try {
                    await this.active.upsertRows(rows, mode);
                } catch (e) {
                    this.degrade(`write failed on ${this.active.kind}: ${msg(e)}`);
                    await this.active.upsertRows(rows, mode);
                }
            });
        } catch (e) {
            this.deps.log(`cutoff write dropped: ${msg(e)}`);
        }
    }

    private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.writeChain.then(fn, fn);
        this.writeChain = run.catch(() => undefined);
        return run;
    }

    /** 只降不升; 升回 MySQL 由恢复探测完成(会把降级期数据一并回灌) */
    private degrade(reason: string): void {
        if (this.active.kind === 'mysql') {
            void this.mysql?.close?.().catch(() => undefined);
            this.mysql = undefined;
            if (this.sqlite) {
                this.active = this.sqlite;
                this.deps.log(`degraded to sqlite buffer (${reason})`);
                this.nextMysqlAttemptAt = Date.now() + this.mysqlRetryMs;
                return;
            }
        }
        if (this.active.kind !== 'memory') {
            this.active = createMemoryBackend();
            this.deps.log(`degraded to memory (${reason})`);
        }
    }

    /** 巡检一拍: 恢复探测 / 缓冲回灌 / Mongo 迁移(定时器与启动各触发一次; 也可手动调用) */
    async housekeep(): Promise<void> {
        if (this.housekeeping || !this.initPromise) return;
        this.housekeeping = true;
        try {
            await this.initPromise;
            const now = Date.now();
            if (this.active.kind !== 'mysql' && this.deps.mysqlConfigured() && now >= this.nextMysqlAttemptAt) {
                await this.tryRecoverMysql();
            }
            if (this.active.kind === 'mysql' && this.sqlite && now >= this.nextSyncAt) {
                await this.trySyncBuffer();
            }
            if (this.deps.mongo && !this.mongoFinished && this.active.kind !== 'memory' && now >= this.nextMongoAttemptAt) {
                await this.tryMigrateMongo();
            }
        } catch (e) {
            this.deps.log(`cutoff housekeep failed: ${msg(e)}`);
        } finally {
            this.housekeeping = false;
        }
    }

    /** SQLite 缓冲 → MySQL(脏标记置位时), 幂等 */
    private async trySyncBuffer(): Promise<void> {
        const sqlite = this.sqlite;
        const mysql = this.mysql;
        if (!sqlite || !mysql) return;
        try {
            const pending = await sqlite.getMeta(SQLITE_PENDING_KEY).catch(() => undefined);
            if (pending !== '1') return;
            await this.runExclusive(async () => {
                // 锁内复查: 可能已被上一轮清掉
                const still = await sqlite.getMeta(SQLITE_PENDING_KEY).catch(() => undefined);
                if (still !== '1') return;
                const n = await syncToMysql(sqlite, mysql);
                await sqlite.setMeta(SQLITE_PENDING_KEY, '0');
                this.deps.log(`backfilled ${n} row(s) from sqlite to mysql`);
            });
            this.nextSyncAt = 0;
        } catch (e) {
            this.nextSyncAt = Date.now() + this.retryMin;
            this.deps.log(`sqlite→mysql backfill failed, will retry: ${msg(e)}`);
        }
    }

    /** MySQL 恢复探测: 回灌缓冲 + 在同一把写锁里切回 MySQL */
    private async tryRecoverMysql(): Promise<void> {
        let mysql: CutoffBackend | undefined;
        try {
            mysql = await this.deps.openMysql();
            if (!mysql) throw new Error('mysql still unavailable');
            const recovered = mysql;
            await this.runExclusive(async () => {
                if (this.sqlite) {
                    const pending = await this.sqlite.getMeta(SQLITE_PENDING_KEY).catch(() => undefined);
                    if (pending === '1') {
                        const n = await syncToMysql(this.sqlite, recovered);
                        await this.sqlite.setMeta(SQLITE_PENDING_KEY, '0');
                        this.deps.log(`backfilled ${n} row(s) from sqlite to mysql`);
                    }
                }
                this.mysql = recovered;
                this.active = recovered;
            });
            this.mysqlRetryMs = this.retryMin;
            this.nextMysqlAttemptAt = 0;
            this.deps.log('mysql recovered, cutoff writes go to mysql');
        } catch (e) {
            await mysql?.close?.().catch(() => undefined);
            this.mysqlRetryMs = Math.min(RETRY_MAX_MS, this.mysqlRetryMs * 2);
            this.nextMysqlAttemptAt = Date.now() + this.mysqlRetryMs;
            this.deps.log(`mysql recovery attempt failed (retry in ${Math.round(this.mysqlRetryMs / 1000)}s): ${msg(e)}`);
        }
    }

    /** MongoDB 旧榜线数据 → 当前后端(只读; marker 成功后写入; 失败退避重试) */
    private async tryMigrateMongo(): Promise<void> {
        const mongo = this.deps.mongo;
        if (!mongo) return;
        try {
            const done = await this.active.getMeta(MONGO_MIGRATION_KEY).catch(() => undefined);
            if (done === '1') {
                this.mongoFinished = true;
                return;
            }
            const docs = await mongo.iterate();
            if (!docs) {
                this.mongoFinished = true;
                return;
            }
            const n = await migrateMongoToBackend(this.active, docs);
            await this.active.setMeta(MONGO_MIGRATION_KEY, '1');
            if (this.active.kind === 'sqlite') {
                // 当前活跃后端是缓冲: 标记待回灌, MySQL 恢复时一并带走
                await this.active.setMeta(SQLITE_PENDING_KEY, '1');
            }
            this.mongoFinished = true;
            this.deps.log(`migrated ${n} row(s) from mongodb cutoff collection (mongodb data kept)`);
            await mongo.close();
        } catch (e) {
            this.mongoRetryMs = Math.min(RETRY_MAX_MS, this.mongoRetryMs * 2);
            this.nextMongoAttemptAt = Date.now() + this.mongoRetryMs;
            this.deps.log(`mongo cutoff migration failed (retry in ${Math.round(this.mongoRetryMs / 1000)}s): ${msg(e)}`);
        }
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }
}
