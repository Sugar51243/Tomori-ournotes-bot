import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { isServerInput, pickServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandSongRankingFromInput } from '../../features/song/songRanking';

/**
 * 歌曲排行榜(前十用户与出分)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 传文本时只在该服的索引里搜索(数据本身只属于这一个服, 不跨服回退)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('songId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandSongRankingFromInput(pickServer(req.body), input, req.body.compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as songRankingRouter };
