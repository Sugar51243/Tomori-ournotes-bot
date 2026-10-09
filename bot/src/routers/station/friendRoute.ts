import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { middleware } from '../middleware';
import { deleteFriend, upsertFriend } from '../../db/adapter';
import { isFriendServer, normalizeServer, defaultServer } from '../../features/types/Server';
import { commandFriendList, DB_DISABLED } from '../../features/friend/friendRoute';

/**
 * 交友区(tsugu 无此功能, 自定义端点):
 * - /friend/upload  按 QQ 号新增或更新(upsert, 一人一条)
 * - /friend/delete  按 QQ 号删除(自报 QQ 号, 弱鉴权)
 * - /friend/list    交友列表图
 * 数据库未配置/连不上时统一返回域内错误, 不 500。
 */

export const friendUploadRouter = express.Router();
friendUploadRouter.post(
    '/',
    [
        body('userId').isString(),
        body('userName').isString().isLength({ min: 1, max: 32 }),
        body('avatarUrl').optional().isString().isLength({ max: 512 }),
        body('playerId').isString().matches(/^\d{1,15}$/),
        body('server').custom(isFriendServer),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { userId, userName, avatarUrl, playerId, server } = req.body;
        try {
            const result = await upsertFriend({
                userId,
                userName,
                avatarUrl,
                playerId,
                server: normalizeServer(server) ?? defaultServer()
            });
            if (result === 'db_disabled') {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            res.status(200).send({ status: 'success', data: '已记录你的交友信息' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/** 删除交友信息的路由(按 QQ 号) */
export const friendDeleteRouter = express.Router();
friendDeleteRouter.post(
    '/',
    [body('userId').isString()],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { userId } = req.body;
        try {
            const deleted = await deleteFriend(userId);
            if (deleted === undefined) {
                return res.status(200).send({ status: 'failed', data: DB_DISABLED });
            }
            res.status(200).send({ status: 'success', data: deleted > 0 ? '已删除你的交友信息' : '没有找到你的交友信息' });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/** 交友列表图路由 */
export const friendListRouter = express.Router();
friendListRouter.post(
    '/',
    [body('compress').optional().isBoolean()],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandFriendList({ compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);
