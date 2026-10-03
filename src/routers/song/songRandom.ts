import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { isServerInput, pickServers } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandSongRandom } from '../../features/song/songRandom';

/**
 * 随机歌曲(多服)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 一个都不传时从全部歌曲里随机。文本命中多首时在命中集合里随机。
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
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandSongRandom(pickServers(req.body), {
                input: pickEntityInput(req.body, ['songId']),
                compress: req.body.compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as songRandomRouter };
