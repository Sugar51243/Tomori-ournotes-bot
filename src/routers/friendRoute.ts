import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { middleware } from './middleware';
import { friendsCollection } from '../data/mongo';
import { drawFriendList } from '../view/friendList';
import { isFriendServer } from '../types/Server';
import { FriendDoc } from '../types/Friend';

/**
 * 交友区(tsugu 无此功能, 自定义端点):
 * - /friend/upload  按 QQ 号新增或更新(upsert, 一人一条)
 * - /friend/delete  按 QQ 号删除(自报 QQ 号, 弱鉴权)
 * - /friend/list    交友列表图
 * 数据库未配置/连不上时统一返回域内错误, 不 500。
 */
const DB_DISABLED = '错误: 服务器未启用数据库';

export const friendUploadRouter = express.Router();
friendUploadRouter.post(
    '/',
    [
        body('userId').isString().matches(/^\d{5,12}$/),
        body('userName').isString().isLength({ min: 1, max: 32 }),
        body('avatarUrl').optional().isString().isLength({ max: 512 }),
        body('playerId').isString().matches(/^\d{1,15}$/),
        body('server').custom(isFriendServer),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { userId, userName, avatarUrl, playerId, server } = req.body;
        try {
            const collection = await friendsCollection().catch(() => undefined);
            if (!collection) {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            const now = new Date();
            await collection.updateOne(
                { userId },
                {
                    $set: { userName, avatarUrl: avatarUrl || undefined, playerId, server, updatedAt: now },
                    $setOnInsert: { userId, createdAt: now }
                },
                { upsert: true }
            );
            res.status(200).send({ status: 'success', data: '已记录你的交友信息' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export const friendDeleteRouter = express.Router();
friendDeleteRouter.post(
    '/',
    [body('userId').isString().matches(/^\d{5,12}$/)],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { userId } = req.body;
        try {
            const collection = await friendsCollection().catch(() => undefined);
            if (!collection) {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            const result = await collection.deleteOne({ userId });
            res.status(200).send({ status: 'success', data: result.deletedCount > 0 ? '已删除你的交友信息' : '没有找到你的交友信息' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export const friendListRouter = express.Router();
friendListRouter.post(
    '/',
    [body('compress').optional().isBoolean()],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandFriendList(req.body.compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandFriendList(compress?: boolean): Promise<Array<Buffer | string>> {
    const collection = await friendsCollection().catch(() => undefined);
    if (!collection) {
        return [DB_DISABLED];
    }
    const friends = await collection.find({}).sort({ updatedAt: -1 }).toArray();
    if (friends.length === 0) {
        return ['交友列表为空'];
    }
    return drawFriendList(friends as FriendDoc[], !!compress);
}
