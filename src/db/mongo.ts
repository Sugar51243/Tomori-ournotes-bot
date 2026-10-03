import { MongoClient, Db, Collection, IndexDescription } from 'mongodb';
import { config } from '../config';
import { logger } from '../logger';
import type { FriendDoc } from '../features/types/Friend';
import type { StationDoc } from '../features/types/Station';
import type { KeywordDoc } from '../features/types/Keyword';
import type { CutoffDoc } from '../features/types/Cutoff';

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

/**
 * 用户关键词集合。
 * 唯一索引落在 (实体, 归一化关键词) 上: 同一实体的重复上传由数据库兜底
 * (并发上传时也只会成功一条), 换个实体挂同一个词是合法的。
 * 该索引的前缀同时覆盖「按实体取关键词」的查询, 不需要再加单列索引。
 */
export async function keywordsCollection(): Promise<Collection<KeywordDoc> | undefined> {
    const db = await getDb();
    if (!db) return undefined;
    await ensureIndexes('keywords', [
        { key: { entityType: 1, entityId: 1, normKeyword: 1 }, name: 'entity_norm_unique', unique: true }
    ]);
    return db.collection<KeywordDoc>('keywords');
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

/**
 * 榜线历史集合: (服务器, 活动, 曲目, 档位, 整点桶) 唯一 —— 采样是 upsert,
 * 同一小时内查询多少次都只留一条记录。
 */
export async function cutoffsCollection(): Promise<Collection<CutoffDoc> | undefined> {
    const db = await getDb();
    if (!db) return undefined;
    await ensureIndexes('cutoffs', [
        { key: { server: 1, eventId: 1, bucket: 1 }, name: 'scope_bucket' },
        { key: { server: 1, eventId: 1, musicId: 1, tier: 1, bucket: 1 }, name: 'point_unique', unique: true }
    ]);
    return db.collection<CutoffDoc>('cutoffs');
}

/**
 * 榜线迁移专用(只读): 把旧 `cutoffs` 集合里的数据搬到 MySQL/SQLite 用。
 *
 * 与社区集合不同, 这里**不看 ENABLE_DB**(那只是社区功能开关, 旧榜线数据可能来自
 * 当时开过 ENABLE_DB 的部署) —— 只要配了 MONGODB_URI 就尝试; 不建索引、不写数据。
 * 连接/读取失败由调用方按"暂不可用"退避重试。
 */
export async function cutoffsForMigration(): Promise<AsyncIterable<CutoffDoc> | undefined> {
    if (!config.mongoUri) return undefined;
    if (!client) {
        client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: config.dbConnectTimeoutMs });
    }
    return client.db(config.mongoDb).collection<CutoffDoc>('cutoffs').find({}).batchSize(1000);
}

/** 关闭连接(进程退出/测试用) */
export async function closeMongo(): Promise<void> {
    await client?.close();
    client = undefined;
    dbPromise = undefined;
}
