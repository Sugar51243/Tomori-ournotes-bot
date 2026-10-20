import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { middleware } from '../middleware';
import { commandRoomList } from '../../features/station/roomList';

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
            const result = await commandRoomList({ roomList: req.body.roomList, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);
