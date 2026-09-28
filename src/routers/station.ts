import express from 'express';
import { body } from 'express-validator';
import { middleware } from './middleware';
import { stationsCollection } from '../data/mongo';
import { config } from '../config';
import { StationDoc, RoomView } from '../types/Station';

/**
 * 车站(房间号共享): 字段与语义对齐 tsugu 的 /station/*
 * - POST /station/submitRoomNumber  上传(同房号重复提交 = 刷新; tsugu 同样没有独立的"修改")
 * - GET|POST /station/queryAllRoom  返回未过期的房间 JSON
 * 与 tsugu 的差别: 存 MongoDB(TTL 索引自动清理), 不是进程内存。
 */
const DB_DISABLED = '错误: 服务器未启用数据库';

/** tsugu 的 platform 归一化: onebot/red/chronocat/llonebot/Napcat → qq */
export function normalizeSource(platform: string): string {
    return ['onebot', 'red', 'chronocat', 'llonebot', 'napcat'].includes(platform.toLowerCase()) ? 'qq' : platform;
}

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
            const collection = await stationsCollection().catch(() => undefined);
            if (!collection) {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            const now = new Date();
            const fields: Record<string, unknown> = {
                number,
                rawMessage,
                source: normalizeSource(String(platform)),
                userId,
                userName,
                time,
                expireAt: new Date(now.getTime() + config.stationTtlS * 1000)
            };
            if (avatarUrl) fields.avatarUrl = avatarUrl;
            await collection.updateOne(
                { number },
                { $set: fields, $setOnInsert: { createdAt: now } },
                { upsert: true }
            );
            res.status(200).send({ status: 'success', data: '提交成功' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/** 未过期房间文档: 按 time 倒序(每个房号只保留一条, 由 number 唯一索引保证) */
export async function queryStations(): Promise<StationDoc[] | undefined> {
    const collection = await stationsCollection().catch(() => undefined);
    if (!collection) return undefined;
    return collection.find({ expireAt: { $gt: new Date() } }).sort({ time: -1 }).toArray();
}

async function handleQueryAllRoom(_req: express.Request, res: express.Response): Promise<void> {
    try {
        const docs = await queryStations();
        if (!docs) {
            res.status(200).send({ status: 'failed', data: DB_DISABLED });
            return;
        }
        res.status(200).send({ status: 'success', data: docs.map(toRoomView) });
    } catch (e) {
        console.log(e);
        res.status(500).send({ status: 'failed', data: '内部错误' });
    }
}

stationRouter.get('/queryAllRoom', handleQueryAllRoom);
stationRouter.post('/queryAllRoom', handleQueryAllRoom);
