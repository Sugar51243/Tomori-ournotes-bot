import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../../render/component/OurNotesPreview';
import { commandSongChart } from '../../features/song/songChart';

/**
 * 谱面图(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`,
 * 传一个字段即可 —— 数字/纯数字字符串按 ID 直查, 其它文本走模糊搜索(唯一命中出谱面图, 多命中出歌曲列表图)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('songId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('compress').optional().isBoolean(),
        body('mirror').optional().isBoolean(),
        // 预览流速(音符速度): 沿用来源的 NoteSpeed 规则(默认 5.00, 范围 1.00~12.00),
        // 数值越高谱面拉得越长、音符间距越大。speed 为同义别名。
        body('noteSpeed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
        body('speed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }
        const options = {
            difficultyId: req.body.difficultyId ?? 3,
            compress: req.body.compress,
            mirror: req.body.mirror ?? false,
            noteSpeed: req.body.noteSpeed ?? req.body.speed ?? NOTE_SPEED_DEFAULT
        };

        try {
            const result = await commandSongChart(fallbackChain(req.body), input, options);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as songChartRouter };
