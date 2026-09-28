import { MongoClient, Db, Collection, IndexDescription } from 'mongodb';
import { config } from '../config';
import { logger } from '../logger';
import type { FriendDoc } from '../types/Friend';
import type { StationDoc } from '../types/Station';

/**
 * 社区功能(交友/车站)的 MongoDB 接入: 惰性单例 + 首次取集合时自建索引。
 * - 未配置 MONGODB_URI → getDb() 返回 undefined(路由据此走"服务器未启用数据库")
 * - 连接/建索引失败 → 抛错, 由路由兜底为域内错误字符串, 不 500
 */
let client: MongoClient | undefined;
let dbPromise: Promise<Db> | undefined;
/** 索引只建一次(按集合名缓存) */
const indexReady = new Map<string, Promise<void>>();

/** 是否配置了数据库(ENABLE_DB 与 URI 都要有) */
export function dbConfigured(): boolean {
    return config.enableDb && !!config.mongoUri;
}

async function connect(): Promise<Db> {
    if (!client) {
        client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: config.dbConnectTimeoutMs });
        await client.connect();
        logger('mongo', `connected: ${config.mongoUri} db=${config.mongoDb}`);
    }
    return client.db(config.mongoDb);
}

/** 取库(未配置时 undefined); 失败抛出, 由调用方转成域内错误 */
export async function getDb(): Promise<Db | undefined> {
    if (!dbConfigured()) return undefined;
    dbPromise ??= connect().catch(e => {
        dbPromise = undefined;                 // 下次请求重试连接
        throw e;
    });
    return dbPromise;
}

/** 建索引(每集合一次): 失败不缓存, 下次重试 */
function ensureIndexes(name: string, indexes: IndexDescription[]): Promise<void> {
    let ready = indexReady.get(name);
    if (!ready) {
        ready = (async () => {
            const db = await getDb();
            if (!db) return;
            await db.collection(name).createIndexes(indexes);
        })().catch(e => {
            indexReady.delete(name);
            throw e;
        });
        indexReady.set(name, ready);
    }
    return ready;
}

/** 交友集合: userId(QQ 号) 唯一 */
export async function friendsCollection(): Promise<Collection<FriendDoc> | undefined> {
    const db = await getDb();
    if (!db) return undefined;
    await ensureIndexes('friends', [{ key: { userId: 1 }, name: 'userId_unique', unique: true }]);
    return db.collection<FriendDoc>('friends');
}

/** 车站集合: expireAt 为 TTL 字段(MongoDB 后台约每 60s 清理过期文档) */
export async function stationsCollection(): Promise<Collection<StationDoc> | undefined> {
    const db = await getDb();
    if (!db) return undefined;
    await ensureIndexes('stations', [
        { key: { expireAt: 1 }, name: 'expireAt_ttl', expireAfterSeconds: 0 },
        { key: { number: 1 }, name: 'number_unique', unique: true }
    ]);
    return db.collection<StationDoc>('stations');
}

/** 关闭连接(进程退出/测试用) */
export async function closeMongo(): Promise<void> {
    await client?.close();
    client = undefined;
    dbPromise = undefined;
}
