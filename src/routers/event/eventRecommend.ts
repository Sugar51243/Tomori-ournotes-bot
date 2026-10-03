import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandEventRecommend } from '../../features/event/eventRecommend';

/**
 * 活动推荐曲(单服回退): 按站点「活动 · 评级」算法, 为击奏live 与 自由live 各自挑推荐曲。
 *
 * 每个目标评级(SS/S/A/B)一段, 段内是**所需综合力最低**的前 5 张谱面(四难度混排)。
 * 图内的 pt/小时、道具/小时由本活动的报酬表估算(演出报酬 + 挑战演出报酬两张都列)。
 * 活动 id 不传时取当前开放的活动; 服务器沿回退链依次查询, 取第一个有该活动的服。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('eventId').optional(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, eventId, compress } = req.body;
        try {
            const result = await commandEventRecommend(fallbackChain(req.body), { id, eventId, compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as eventRecommendRouter };
