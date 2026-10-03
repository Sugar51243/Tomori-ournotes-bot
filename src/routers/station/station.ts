import express from 'express';
import { body } from 'express-validator';
import { middleware } from '../middleware';
import { commandQueryAllRooms, commandSubmitRoomNumber } from '../../features/station/station';

/**
 * 车站(房间号共享): 字段与语义对齐 tsugu 的 /station/*
 * - POST /station/submitRoomNumber  上传(同房号重复提交 = 刷新; tsugu 同样没有独立的"修改")
 * - GET|POST /station/queryAllRoom  返回未过期的房间 JSON
 * 与 tsugu 的差别: 存 MongoDB(TTL 索引自动清理), 不是进程内存。
 */
const DB_DISABLED = '错误: 服务器未启用数据库';

/** 车站路由(上传房号 / 查全部未过期房间) */
export const stationRouter = express.Router();

stationRouter.post(
    '/submitRoomNumber',
    [
        body('number').isInt(),
        body('rawMessage').isString().isLength({ min: 1, max: 500 }),
        body('platform').isString(),
        body('userId').isString().isLength({ min: 1, max: 32 }),
        body('userName').isString().isLength({ min: 1, max: 64 }),
        body('time').isInt(),
        body('avatarUrl').optional().isString().isLength({ max: 512 }),
        body('bandoriStationToken').optional().isString(),   // tsugu 兼容字段, 本服务不外发故忽略
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { number, rawMessage, platform, userId, userName, time, avatarUrl } = req.body;
        try {
            const result = await commandSubmitRoomNumber({ number, rawMessage, platform, userId, userName, time, avatarUrl });
            if (result === 'db_disabled') {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            res.status(200).send({ status: 'success', data: '提交成功' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

async function handleQueryAllRoom(_req: express.Request, res: express.Response): Promise<void> {
    try {
        const rooms = await commandQueryAllRooms();
        if (!rooms) {
            res.status(200).send({ status: 'failed', data: DB_DISABLED });
            return;
        }
        res.status(200).send({ status: 'success', data: rooms });
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
}

stationRouter.get('/queryAllRoom', handleQueryAllRoom);
stationRouter.post('/queryAllRoom', handleQueryAllRoom);
