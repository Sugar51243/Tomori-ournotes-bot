import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../../render/component/OurNotesPreview';
import { commandSong } from '../../features/song/searchSong';

/**
 * 查歌(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`。
 * 传单个字段即可 —— 纯数字即按 ID 直查, 其它文本走模糊搜索, 不再需要先调 /fuzzySearch。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('songId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
        // 模糊结果唯一命中时的出图方式: detail=歌曲详情(默认, 查曲调用方) / chart=直接出该曲谱面图(查谱面调用方)。
        // chart 模式下 difficultyId/mirror/noteSpeed(或同义 speed) 透传给谱面渲染; 多结果时始终出列表图。
        body('singleDraw').optional().isIn(['detail', 'chart']),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('mirror').optional().isBoolean(),
        body('noteSpeed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
        body('speed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }

        try {
            const result = await commandSong(fallbackChain(req.body), {
                input,
                compress: req.body.compress,
                singleDraw: req.body.singleDraw,
                difficultyId: req.body.difficultyId,
                mirror: req.body.mirror,
                noteSpeed: req.body.noteSpeed ?? req.body.speed,
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as searchSongRouter };
