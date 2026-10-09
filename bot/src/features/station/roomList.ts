import { drawStationList } from '../../render/view/station/stationList';
import { queryStations, toRoomViewForRender } from './station';
import { RoomView, normalizeStationTime } from '../types/Station';

/**
 * 车站列表图的功能实现:
 * - 传了 `roomList` → 直接渲染这批(tsugu 兼容, 不查库)
 * - 没传 → 查本服务 MongoDB 的未过期房间
 */

/** 校验并规整 tsugu 风格的 roomList 入参; 形状不对返回 undefined */
function parseRoomList(input: unknown): RoomView[] | undefined {
    if (!Array.isArray(input)) return undefined;
    const rooms: RoomView[] = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') return undefined;
        const r = item as Record<string, unknown>;
        if (typeof r.number !== 'number' || typeof r.rawMessage !== 'string' || typeof r.userId !== 'string') return undefined;
        const room: RoomView = {
            number: r.number,
            rawMessage: r.rawMessage,
            source: typeof r.source === 'string' ? r.source : 'qq',
            userId: r.userId,
            userName: typeof r.userName === 'string' ? r.userName : '未知',
            // 原值照留(与 tsugu 一致), 归一秒值给渲染用(OneBot/tsugu 给秒, 也有给毫秒的)
            time: typeof r.time === 'number' ? r.time : Date.now(),
            timeMs: normalizeStationTime(r.time)
        };
        if (typeof r.avatarUrl === 'string' && r.avatarUrl) room.avatarUrl = r.avatarUrl;
        rooms.push(room);
        if (rooms.length >= 200) break;
    }
    return rooms;
}

export interface RoomListQuery {
    /** tsugu 兼容的现成房间列表; 不传 = 查本服务数据库 */
    roomList?: unknown;
    compress?: boolean;
}

/** 车站列表图入口: 传 roomList 直接渲染(tsugu 兼容), 否则查库未过期房间 */
export async function commandRoomList(query: RoomListQuery = {}): Promise<Array<Buffer | string>> {
    const compress = !!query.compress;
    let rooms: RoomView[] | undefined;
    let expireAt: (Date | undefined)[] = [];
    if (query.roomList !== undefined) {
        rooms = parseRoomList(query.roomList);
        if (!rooms) return ['错误: 车牌格式错误'];
    } else {
        const docs = await queryStations();
        if (!docs) return ['错误: 服务器未启用数据库'];
        rooms = docs.map(toRoomViewForRender);
        // 剩余时间由库里的 expireAt 计算; tsugu 兼容入参没有该字段
        expireAt = docs.map(d => d.expireAt);
    }
    if (rooms.length === 0) {
        return ['车站列表为空'];
    }
    return drawStationList(rooms, expireAt, !!compress);
}
