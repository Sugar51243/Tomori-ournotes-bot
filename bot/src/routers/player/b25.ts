import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandB25 } from '../../features/player/b25';

/**
 * B25 · BEST 25 计分榜。
 *
 * 数据来自网页账号包(导入时算好的前 25 张谱面), **需要该账号包的歌曲公开**。
 * 玩家 ID 可省略 = 用绑定列表里的默认账号。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('playerId').optional().custom(v => v === undefined || typeof v === 'number' || (typeof v === 'string' && /^\d{1,19}$/.test(v))),
        body('userId').optional().isString().isLength({ min: 1, max: 32 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandB25(req.body);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as b25Router };
