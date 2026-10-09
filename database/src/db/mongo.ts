import { MongoClient, Db, Collection, Document, IndexDescription } from 'mongodb';
import { config } from '../config';
import { logger, describeError } from '../logger';
import { AppError } from '../http/errors';

/**
 * MongoDB 接入 —— 全系统唯一一处。搬到本服务前分布在 bot 的 src/db/mongo.ts
 * 与 web 的 web/server/src/db/mongo.ts 两处(两边注释里互相提醒"索引与字段契约
 * 必须完全一致"), 现在索引只在启动时由本服务建一次, 契约天然只有一份。
 *
 * 集合与索引(名字与 key 规格是历史契约, **不许改**, 改了会与现存数据/查询对不上):
 * - keywords  {entityType, entityId, normKeyword} unique
 * - friends   {userId} unique
 * - stations  {expireAt} TTL + {number} unique
 * - bindings  {userId, accountId} unique + {userId}
 * - cutoffs   {server, eventId, bucket} + {server, eventId, musicId, tier, bucket} unique
 *   (旧榜线集合, 只读; 建索引只为查询形态与老部署一致)
 */

let client: MongoClient | undefined;
let dbPromise: Promise<Db> | undefined;
let lastError: string | undefined;
/** 索引只建一次(按集合名缓存); 失败不缓存, 下次重试 */
const indexReady = new Map<string, Promise<void>>();

const INDEXES: Record<string, IndexDescription[]> = {
    keywords: [
        { key: { entityType: 1, entityId: 1, normKeyword: 1 }, name: 'entity_norm_unique', unique: true },
    ],
    friends: [
        { key: { userId: 1 }, name: 'userId_unique', unique: true },
    ],
    stations: [
        { key: { expireAt: 1 }, name: 'expireAt_ttl', expireAfterSeconds: 0 },
        { key: { number: 1 }, name: 'number_unique', unique: true },
    ],
    bindings: [
        { key: { userId: 1, accountId: 1 }, name: 'user_account_unique', unique: true },
        { key: { userId: 1 }, name: 'user_idx' },
    ],
    cutoffs: [
        { key: { server: 1, eventId: 1, bucket: 1 }, name: 'scope_bucket' },
        { key: { server: 1, eventId: 1, musicId: 1, tier: 1, bucket: 1 }, name: 'point_unique', unique: true },
    ],
};

async function connect(): Promise<Db> {
    if (!client) {
        client = new MongoClient(config.mongo.uri, {
            serverSelectionTimeoutMS: config.mongo.timeoutMs,
            maxPoolSize: 20,
        });
        await client.connect();
        logger('mongo', `connected: ${config.mongo.uri} db=${config.mongo.db}`);
    }
    return client.db(config.mongo.db);
}

/** 取库; 失败抛出 AppError(503), 调用方不用各自处理连接错误 */
export async function getDb(): Promise<Db> {
    dbPromise ??= connect()
        .then(db => {
            lastError = undefined;
            return db;
        })
        .catch(e => {
            lastError = describeError(e);
            dbPromise = undefined; // 下次请求重试
            throw new AppError('DB_UNAVAILABLE', '社区数据库暂时不可用，请稍后再试');
        });
    return dbPromise;
}

/** 建索引(每集合一次); 失败不缓存, 下次重试 */
function ensureIndexes(name: string): Promise<void> {
    let ready = indexReady.get(name);
    if (!ready) {
        ready = (async () => {
            const db = await getDb();
            await db.collection(name).createIndexes(INDEXES[name]);
        })().catch(e => {
            indexReady.delete(name);
            throw e;
        });
        indexReady.set(name, ready);
    }
    return ready;
}

/** 取集合(顺手确保索引); 新集合先登记到 INDEXES 才会被建索引 */
export async function collection<T extends Document = Document>(name: keyof typeof INDEXES & string): Promise<Collection<T>> {
    const db = await getDb();
    await ensureIndexes(name);
    return db.collection<T>(name);
}

/** 启动时预热: 把全部集合的索引先建出来并验证连接; 失败只记日志(请求时会重试) */
export async function warmMongo(): Promise<void> {
    try {
        await getDb();
        for (const name of Object.keys(INDEXES)) await ensureIndexes(name);
        logger('mongo', `indexes ready (${Object.keys(INDEXES).join(', ')})`);
    } catch (e) {
        logger('mongo', `启动预热失败(请求时会重试): ${describeError(e)}`, 'warn');
    }
}

export interface MongoStatus {
    ok: boolean;
    database: string;
    error?: string;
}

export async function mongoStatus(): Promise<MongoStatus> {
    try {
        const db = await getDb();
        await db.command({ ping: 1 });
        return { ok: true, database: config.mongo.db };
    } catch (e) {
        return { ok: false, database: config.mongo.db, error: lastError ?? describeError(e) };
    }
}

export async function closeMongo(): Promise<void> {
    const c = client;
    client = undefined;
    dbPromise = undefined;
    await c?.close().catch(() => undefined);
}
