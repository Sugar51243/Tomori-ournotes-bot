import { listStationDocs, submitStationRoom } from '../../db/adapter';
import { StationDoc, RoomView, normalizeStationTime } from '../types/Station';

/**
 * 车站(房间号共享)的功能实现: 字段与语义对齐 tsugu 的 /station/*
 * - POST /station/submitRoomNumber  上传(同房号重复提交 = 刷新; tsugu 同样没有独立的"修改")
 * - GET|POST /station/queryAllRoom  返回未过期的房间 JSON
 * 与 tsugu 的差别: 存 MongoDB(TTL 索引自动清理), 不是进程内存。
 */

/** tsugu 的 platform 归一化: onebot/red/chronocat/llonebot/Napcat → qq */
export function normalizeSource(platform: string): string {
    return ['onebot', 'red', 'chronocat', 'llonebot', 'napcat'].includes(platform.toLowerCase()) ? 'qq' : platform;
}

/**
 * 对外结构: **只出原值** —— 前端可能自己用 time 算「多久前」, 换算单位等于改契约。
 * timeMs 仅在服务端内部流转(出图/排序)。
 */
export function toRoomView(doc: StationDoc): RoomView {
    const view: RoomView = {
        number: doc.number,
        rawMessage: doc.rawMessage,
        source: doc.source,
        userId: doc.userId,
        userName: doc.userName,
        time: doc.time
    };
    if (doc.avatarUrl) view.avatarUrl = doc.avatarUrl;
    return view;
}

/** 出图用的房间视图: 带上归一秒值(老数据没有 timeMs 时按量级现算) */
export function toRoomViewForRender(doc: StationDoc): RoomView {
    return { ...toRoomView(doc), timeMs: doc.timeMs ?? normalizeStationTime(doc.time) };
}

/** 未过期房间文档: 按 time 倒序(每个房号只保留一条, 由 number 唯一索引保证) */
export async function queryStations(): Promise<StationDoc[] | undefined> {
    return listStationDocs();
}

export interface SubmitRoomFields {
    number: number;
    rawMessage: string;
    platform: string;
    userId: string;
    userName: string;
    time: number;
    avatarUrl?: string;
}

/** 提交房间号(字段归一化 + 写库); 集合不可得时返回 db_disabled, 写入失败照旧抛出 */
export async function commandSubmitRoomNumber(fields: SubmitRoomFields): Promise<'ok' | 'db_disabled'> {
    return submitStationRoom({
        number: fields.number,
        rawMessage: fields.rawMessage,
        source: normalizeSource(String(fields.platform)),
        userId: fields.userId,
        userName: fields.userName,
        time: fields.time,
        timeMs: normalizeStationTime(fields.time),
        avatarUrl: fields.avatarUrl
    });
}

/** 未过期房间的对外视图(只出原值); 集合不可得时返回 undefined */
export async function commandQueryAllRooms(): Promise<RoomView[] | undefined> {
    const docs = await listStationDocs();
    if (!docs) return undefined;
    return docs.map(toRoomView);
}
