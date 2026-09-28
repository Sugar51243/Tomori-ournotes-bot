import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { middleware } from './middleware';
import { drawStationList } from '../view/stationList';
import { queryStations, toRoomView } from './station';
import { RoomView } from '../types/Station';

/**
 * 车站列表图:
 * - 传了 `roomList` → 直接渲染这批(tsugu 兼容, 不查库)
 * - 没传 → 查本服务 MongoDB 的未过期房间
 */
export const roomListRouter = express.Router();

roomListRouter.post(
    '/',
    [
        body('roomList').optional().isArray({ max: 200 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandRoomList(req.body.roomList, req.body.compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

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
            time: typeof r.time === 'number' ? r.time : Date.now()
        };
        if (typeof r.avatarUrl === 'string' && r.avatarUrl) room.avatarUrl = r.avatarUrl;
        rooms.push(room);
        if (rooms.length >= 200) break;
    }
    return rooms;
}

export async function commandRoomList(input: unknown, compress?: boolean): Promise<Array<Buffer | string>> {
    let rooms: RoomView[] | undefined;
    let expireAt: (Date | undefined)[] = [];
    if (input !== undefined) {
        rooms = parseRoomList(input);
        if (!rooms) return ['错误: 车牌格式错误'];
    } else {
        const docs = await queryStations();
        if (!docs) return ['错误: 服务器未启用数据库'];
        rooms = docs.map(toRoomView);
        // 剩余时间由库里的 expireAt 计算; tsugu 兼容入参没有该字段
        expireAt = docs.map(d => d.expireAt);
    }
    if (rooms.length === 0) {
        return ['车站列表为空'];
    }
    return drawStationList(rooms, expireAt, !!compress);
}
