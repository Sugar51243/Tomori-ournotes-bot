import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandDeckBuilder } from '../../features/player/deckBuilder';

/**
 * 组卡工具(与网页组卡器同逻辑)。
 *
 * 账号包里的卡片/道具 + 网页 master bundle + bot 自己谱面效率与活动报酬 ——
 * 出推荐队伍(综合力明细)与收益/效率曲。需要该账号包的卡片与道具公开。
 * 活动模式: 默认跟随进行中的活动; 也可带 eventId 指定某期活动(往期/未开始也能用)。
 * 玩家 ID 可省略 = 用绑定列表里的默认账号。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('playerId').optional().custom(v => v === undefined || typeof v === 'number' || (typeof v === 'string' && /^\d{1,19}$/.test(v))),
        body('userId').optional().isString().isLength({ min: 1, max: 32 }),
        body('mode').optional().isIn(['normal', 'event', 'auto']),
        // 活动模式: 可指定活动 ID(往期/未开始的活动也能用它的报酬表); 不传 = 进行中的活动
        body('eventId').optional().custom(v => v === undefined || v === '' || Number.isInteger(Number(v))),
        body('id').optional().custom(v => v === undefined || v === '' || Number.isInteger(Number(v))),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandDeckBuilder(req.body);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as deckBuilderRouter };
