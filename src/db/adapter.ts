/**
 * 数据库管理器 · adapter —— 所有本地数据存取行为的唯一对外出口。
 *
 * 磁盘原语: 对 DiskCache 单例的透传(读取/写入/触碰/新鲜度判断/单飞/版本清理, 行为逐字一致)。
 * 静态数据: master 表 / 区域上下文 / 派生关系 / 技能 / 贴纸 / 多服信息行 / 图片缓存,
 *           读表时的「行 -> 领域对象」格式转换在各自模块内完成, 原始行不对外泄漏。
 * 社区数据: 车站/交友/绑定统一走「数据库 API」(database/ 项目)并在此收口, 路由不再接触存储。
 */
import { config } from '../config';
import { diskCache } from './cache';
import { callDbApiSoft, dbApiConfigured } from './apiClient';
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

// ---- 社区数据(经数据库 API) ----

/** 社区功能是否配置就绪(ENABLE_DB 开关 + 数据库 API 地址); 未就绪时相关命令报"服务器未启用数据库" */
export function dbConfigured(): boolean {
    return config.enableDb && dbApiConfigured();
}

/**
 * 连接层的"没配/连不上"折叠成 undefined(与旧的 `.catch(() => undefined)` → db_disabled 一致);
 * 业务错误(冲突、重复)照旧抛出。
 */
export interface StationRoomFields {
    number: number;
    rawMessage: string;
    source: string;
    userId: string;
    userName: string;
    time: number;
    /** 归一秒值(只给出图/排序用); expireAt 由数据库 API 按统一 TTL 计算 */
    timeMs: number;
    avatarUrl?: string;
}

/** 上传/刷新房间号(同房号 upsert); 连不上返回 db_disabled, 写入失败照旧抛出 */
export async function submitStationRoom(fields: StationRoomFields): Promise<'ok' | 'db_disabled'> {
    const res = await callDbApiSoft<{ ok: true }>('stations', 'submit', {
        number: fields.number,
        rawMessage: fields.rawMessage,
        source: fields.source,
        userId: fields.userId,
        userName: fields.userName,
        time: fields.time,
        timeMs: fields.timeMs,
        ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
        // bot 语义: 同房号谁提交都覆盖(web 侧走 claim=true 的归属检查)
        claim: false,
    });
    return res === undefined ? 'db_disabled' : 'ok';
}

/** 未过期房间文档: 按归一秒值倒序; 连不上返回 undefined */
export async function listStationDocs(): Promise<StationDoc[] | undefined> {
    return callDbApiSoft<StationDoc[]>('stations', 'listActive');
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
    const res = await callDbApiSoft<{ ok: true }>('friends', 'upsert', {
        userId: fields.userId,
        userName: fields.userName,
        ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
        playerId: fields.playerId,
        server: fields.server,
    });
    return res === undefined ? 'db_disabled' : 'ok';
}

/** 按 userId 删除; 返回删除条数, 连不上返回 undefined */
export async function deleteFriend(userId: string): Promise<number | undefined> {
    const res = await callDbApiSoft<{ removed: number }>('friends', 'remove', { userId });
    return res?.removed;
}

/** 交友列表(updatedAt 倒序); 连不上返回 undefined */
export async function listFriendDocs(): Promise<FriendDoc[] | undefined> {
    return callDbApiSoft<FriendDoc[]>('friends', 'list');
}

// ---- 玩家绑定(一个 QQ 可绑多个账号) ----

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
 * 该用户的**第一个**绑定自动设为默认; 已存在但没有默认的(老数据/异常)也顺手补一个
 * —— 默认项晋升逻辑在服务端整段执行。
 */
export async function addBinding(fields: BindingFields): Promise<'ok' | 'db_disabled'> {
    const res = await callDbApiSoft<{ ok: true }>('bindings', 'add', {
        userId: fields.userId,
        accountId: fields.accountId,
        playerId: fields.playerId,
        server: fields.server,
        ...(fields.label ? { label: fields.label } : {}),
    });
    return res === undefined ? 'db_disabled' : 'ok';
}

/** 某用户的全部绑定: 默认在前, 其余按创建时间 */
export async function listBindings(userId: string): Promise<BindingDoc[] | undefined> {
    return callDbApiSoft<BindingDoc[]>('bindings', 'list', { userId });
}

/** 默认绑定(没有默认标记时取最近更新的一条); db_disabled 与"没有绑定"分开表达 */
export async function getDefaultBinding(userId: string): Promise<BindingLookup> {
    const doc = await callDbApiSoft<BindingDoc | null>('bindings', 'getDefault', { userId });
    return doc === undefined ? { status: 'db_disabled' } : { status: 'ok', doc };
}

/** 解绑指定账号; 若删掉的正是默认账号, 服务端会把最早的一条提升为默认 */
export async function removeBinding(userId: string, accountId: number): Promise<'ok' | 'not_found' | 'db_disabled'> {
    const res = await callDbApiSoft<{ removed: boolean }>('bindings', 'remove', { userId, accountId });
    if (res === undefined) return 'db_disabled';
    return res.removed ? 'ok' : 'not_found';
}

/** 切换默认账号 */
export async function setDefaultBinding(userId: string, accountId: number): Promise<'ok' | 'not_found' | 'db_disabled'> {
    const res = await callDbApiSoft<{ updated: boolean }>('bindings', 'setDefault', { userId, accountId });
    if (res === undefined) return 'db_disabled';
    return res.updated ? 'ok' : 'not_found';
}
