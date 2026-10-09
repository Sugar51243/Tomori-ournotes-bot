import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandEventRanking } from '../../features/event/eventRanking';

/**
 * 活动歌榜(活动歌曲排行榜)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**;
 * 活动 id 不传时取该服**当前开放的活动**。
 *
 * 同一 router 挂两个路径:
 * - `/eventSongRanking` —— 正名(活动歌榜)
 * - `/eventRanking`     —— 旧路径, 保留兼容
 *
 * `rank` 参数(榜线): 10 / 100 / 1000 / 5000 / 10000 —— 取**到该名次为止的 10 名**画图
 * (如 rank=100 → 第 91~100 名)。上游每曲榜固定只给前 100, 所以超出数据范围的档位
 * **不适配**: 该曲的段里会注明「榜不足该档」, 完全不支持时返回领域错误并列出可用档位。
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
            const result = await commandEventRanking(pickServer(req.body), { id, eventId, rank, compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as eventRankingRouter };
