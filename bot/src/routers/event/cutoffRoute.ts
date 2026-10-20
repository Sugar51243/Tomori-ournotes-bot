import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandCutoff } from '../../features/event/cutoffRoute';

/**
 * 活动榜线(各档分数随时间的变化, 折线图)。
 *
 * 与「活动歌榜」(/eventSongRanking) 分开: 那边出的是**当前**排行榜图, 这边出的是**历史**折线图。
 * 上游没有历史接口, 数据由本地采样攒(见 tasks/cutoff/ 与 db/cutoff/)。
 *
 * 参数:
 * - `id` / `eventId`: 活动 id; 传文字则走**模糊搜索** —— 命中多个活动时返回活动列表图(与查活动同款)
 * - `rank`: 只取某一档(10/100/1000/5000/10000), 不传则画全部支持的档位
 * - 服务器: 单服, 取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('eventId').optional(),
        body('rank').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, eventId, rank, compress } = req.body;
        try {
            const result = await commandCutoff(pickServer(req.body), { id, eventId, rank, compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as cutoffRouter };
