/**
 * 数据库管理器 · adapter —— 所有本地数据存取行为的唯一对外出口。
 *
 * 磁盘原语: 对 DiskCache 单例的透传(读取/写入/触碰/新鲜度判断/单飞/版本清理, 行为逐字一致)。
 * 静态数据: master 表 / 区域上下文 / 派生关系 / 技能 / 贴纸 / 多服信息行 / 图片缓存,
 *           读表时的「行 -> 领域对象」格式转换在各自模块内完成, 原始行不对外泄漏。
 * 社区数据: Mongo 集合(车站/交友)统一在此收口, 路由不再直连驱动。
 */
import { config } from '../config';
import { diskCache } from './cache';
import { bindingsCollection, dbConfigured, friendsCollection, stationsCollection } from './mongo';
import type { FriendDoc } from '../features/types/Friend';
import type { StationDoc } from '../features/types/Station';
import type { FriendServer } from '../features/types/Server';
import type { BindingDoc } from '../features/types/Binding';

// ---- 磁盘原语 ----

export function readCache(key: string): Promise<{ data: Buffer; mtimeMs: number; etag?: string } | undefined> {
    return diskCache.read(key);
}

/** 写磁盘缓存条目(opts.etag 会存进伴生文件) */
export function writeCache(key: string, data: Buffer, opts?: { etag?: string }): Promise<void> {
    return diskCache.write(key, data, opts);
}

/** 触碰缓存条目: 只刷新修改时间(ETag 304 时续期用), 不写内容 */
export function touchCache(key: string): Promise<void> {
    return diskCache.touch(key);
}

/** 缓存条目是否在 TTL 内仍新鲜 */
export function isCacheFresh(cached: { mtimeMs: number } | undefined, ttlS: number): boolean {
    return diskCache.isFresh(cached, ttlS);
}

/** 单飞合并: 同一键的并发取数只跑一次, 其余共享结果 */
export function singleFlight<T>(key: string, fetcher: () => Promise<T | undefined>): Promise<T | undefined> {
    return diskCache.singleFlight(key, fetcher);
}

/** 清理该服 masterdata 的旧版本目录(含数据源前缀布局), 只保留 keepVersions 里的版本 */
export function pruneMasterdataVersions(server: string, keepVersions: string[]): Promise<void> {
    return diskCache.pruneMasterdataVersions(server, keepVersions);
}

// ---- 静态数据 / 领域访问(格式转换在各自模块内完成) ----

export * from './masterdata/client';
export * from './masterdata';
export * from './masterdata/text';
export * from './region';
export * from './keywords';
export * from './cutoff/store';
export * from './imageCache';
export * from './relations';
export * from './skills';
export * from './stamps';
export * from './serverInfo';

// ---- 社区数据(Mongo) ----

export { dbConfigured };

export interface StationRoomFields {
    number: number;
    rawMessage: string;
    source: string;
    userId: string;
    userName: string;
    time: number;
    /** 归一秒值(只给出图/排序用) */
    timeMs: number;
    avatarUrl?: string;
}

/** 上传/刷新房间号(同房号 upsert); 集合不可得时返回 db_disabled, 写入失败照旧抛出 */
export async function submitStationRoom(fields: StationRoomFields): Promise<'ok' | 'db_disabled'> {
    const collection = await stationsCollection().catch(() => undefined);
    if (!collection) return 'db_disabled';
    const now = new Date();
    const doc: Record<string, unknown> = {
        number: fields.number,
        rawMessage: fields.rawMessage,
        source: fields.source,
        userId: fields.userId,
        userName: fields.userName,
        // time 原样存(对外 JSON 与之前完全一致); timeMs 是归一秒值, 只给出图与排序用
        time: fields.time,
        timeMs: fields.timeMs,
        expireAt: new Date(now.getTime() + config.stationTtlS * 1000)
    };
    if (fields.avatarUrl) doc.avatarUrl = fields.avatarUrl;
    await collection.updateOne(
        { number: fields.number },
        { $set: doc, $setOnInsert: { createdAt: now } },
        { upsert: true }
    );
    return 'ok';
}

/** 未过期房间文档: 按归一秒值倒序; 集合不可得时返回 undefined */
export async function listStationDocs(): Promise<StationDoc[] | undefined> {
    const collection = await stationsCollection().catch(() => undefined);
    if (!collection) return undefined;
    // 排序用归一秒值(老数据没有 timeMs 时退回 time): 客户端单位不一时 time 之间不可比
    return collection.find({ expireAt: { $gt: new Date() } }).sort({ timeMs: -1, time: -1 }).toArray();
}

export interface FriendFields {
    userId: string;
    userName: string;
    avatarUrl?: string;
    playerId: string;
    server: FriendServer;
}

/** 新增/更新交友信息(按 userId upsert, 一人一条) */
export async function upsertFriend(fields: FriendFields): Promise<'ok' | 'db_disabled'> {
    const collection = await friendsCollection().catch(() => undefined);
    if (!collection) return 'db_disabled';
    const now = new Date();
    await collection.updateOne(
        { userId: fields.userId },
        {
            // 归一化写入: 新记录不再存 'hk-tw-mo' 别名(读取侧仍兼容旧数据)
            $set: { userName: fields.userName, avatarUrl: fields.avatarUrl || undefined, playerId: fields.playerId, server: fields.server, updatedAt: now },
            $setOnInsert: { userId: fields.userId, createdAt: now }
        },
        { upsert: true }
    );
    return 'ok';
}

/** 按 userId 删除; 返回删除条数, 集合不可得时返回 undefined */
export async function deleteFriend(userId: string): Promise<number | undefined> {
    const collection = await friendsCollection().catch(() => undefined);
    if (!collection) return undefined;
    const result = await collection.deleteOne({ userId });
    return result.deletedCount;
}

/** 交友列表(updatedAt 倒序); 集合不可得时返回 undefined */
export async function listFriendDocs(): Promise<FriendDoc[] | undefined> {
    const collection = await friendsCollection().catch(() => undefined);
    if (!collection) return undefined;
    return (await collection.find({}).sort({ updatedAt: -1 }).toArray()) as FriendDoc[];
}

// ---- 玩家绑定(Mongo; 一个 QQ 可绑多个账号) ----

export interface BindingFields {
    userId: string;
    /** 网页账号包 id */
    accountId: number;
    playerId: string;
    server: string;
    /** 网页上给这条账号包的备注名 */
    label?: string;
}

/** 查询绑定的结果: 与「数据库不可用」区分开, 命令才能给对不同文案 */
export type BindingLookup =
    | { status: 'ok'; doc: BindingDoc | null }
    | { status: 'db_disabled' };

/**
 * 新增/更新一条绑定(按 userId+accountId upsert)。
 * 该用户的**第一个**绑定自动设为默认; 已存在但没有默认的(老数据/异常)也顺手补一个。
 */
export async function addBinding(fields: BindingFields): Promise<'ok' | 'db_disabled'> {
    const collection = await bindingsCollection().catch(() => undefined);
    if (!collection) return 'db_disabled';
    const now = new Date();
    const existing = await collection.countDocuments({ userId: fields.userId });
    const hasDefault = await collection.countDocuments({ userId: fields.userId, isDefault: true });
    await collection.updateOne(
        { userId: fields.userId, accountId: fields.accountId },
        {
            $set: {
                playerId: fields.playerId,
                server: fields.server,
                label: fields.label || undefined,
                updatedAt: now
            },
            $setOnInsert: {
                userId: fields.userId,
                accountId: fields.accountId,
                isDefault: existing === 0 || hasDefault === 0,
                createdAt: now
            }
        },
        { upsert: true }
    );
    return 'ok';
}

/** 某用户的全部绑定: 默认在前, 其余按创建时间 */
export async function listBindings(userId: string): Promise<BindingDoc[] | undefined> {
    const collection = await bindingsCollection().catch(() => undefined);
    if (!collection) return undefined;
    return (await collection.find({ userId }).sort({ isDefault: -1, createdAt: 1 }).toArray()) as BindingDoc[];
}

/** 默认绑定(没有默认标记时取最近更新的一条); db_disabled 与"没有绑定"分开表达 */
export async function getDefaultBinding(userId: string): Promise<BindingLookup> {
    const collection = await bindingsCollection().catch(() => undefined);
    if (!collection) return { status: 'db_disabled' };
    const doc = await collection.findOne({ userId, isDefault: true })
        ?? await collection.findOne({ userId }, { sort: { updatedAt: -1 } });
    return { status: 'ok', doc: (doc as BindingDoc | null) ?? null };
}

/** 解绑指定账号; 若删掉的正是默认账号, 把最早的一条提升为默认 */
export async function removeBinding(userId: string, accountId: number): Promise<'ok' | 'not_found' | 'db_disabled'> {
    const collection = await bindingsCollection().catch(() => undefined);
    if (!collection) return 'db_disabled';
    const doc = await collection.findOneAndDelete({ userId, accountId });
    if (!doc) return 'not_found';
    if (doc.isDefault) {
        const next = await collection.findOne({ userId }, { sort: { createdAt: 1 } });
        if (next) await collection.updateOne({ _id: next._id }, { $set: { isDefault: true, updatedAt: new Date() } });
    }
    return 'ok';
}

/** 切换默认账号 */
export async function setDefaultBinding(userId: string, accountId: number): Promise<'ok' | 'not_found' | 'db_disabled'> {
    const collection = await bindingsCollection().catch(() => undefined);
    if (!collection) return 'db_disabled';
    const target = await collection.findOne({ userId, accountId });
    if (!target) return 'not_found';
    await collection.updateMany({ userId, isDefault: true }, { $set: { isDefault: false, updatedAt: new Date() } });
    await collection.updateOne({ userId, accountId }, { $set: { isDefault: true, updatedAt: new Date() } });
    return 'ok';
}
