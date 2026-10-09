import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandPlayerCard } from '../../features/player/playerCard';

/**
 * 查名片(从查玩家拆出): 单独把玩家自制名片(profile card)的原图拿出来。
 *
 * - 传 page: 只出那一页(1~3); 不传: 按页依次出全部原图。
 * - 数据源与查玩家同一套(上游回退链); 玩家 ID 可省略 = 用绑定列表里的默认账号。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('playerId').optional().custom(v => v === undefined || typeof v === 'number' || (typeof v === 'string' && /^\d{1,19}$/.test(v))),
        body('userId').optional().isString().isLength({ min: 1, max: 32 }),
        body('page').optional().custom(v => v === undefined || v === '' || Number.isInteger(Number(v))),
        body('useEasyBG').optional().isBoolean(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandPlayerCard(req.body);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as playerCardRouter };
