import express from 'express';
import { body } from 'express-validator';
import { pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandSongChartData, resolveSongChartTarget } from '../../features/song/songChartData';

/**
 * 谱面数据端点(纯 JSON, 不 base64):
 * POST { id | songId | text | fuzzySearchResult, difficultyId(0-3), mirror?, format?: 'raw'|'simple'|'both' }
 * -> { status:'success', data:{ meta, raw?, simple? } }
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput), 传一个字段即可:
 * 数字/纯数字字符串按 ID 直查; 其它文本走模糊搜索(唯一命中即取该曲)。
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
        body('mirror').optional().isBoolean(),
        body('format').optional().isIn(['raw', 'simple', 'both']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(400).send({ status: 'failed', data: '参数错误', error: [{ msg: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' }] });
        }
        try {
            const target = await resolveSongChartTarget(fallbackChain(req.body), input);
            if (!target.ok) {
                return res.send({ status: 'failed', data: target.message });
            }
            const result = await commandSongChartData(target.server, {
                songId: target.songId,
                difficultyId: req.body.difficultyId ?? 3,
                mirror: req.body.mirror ?? false,
                format: req.body.format ?? 'simple'
            });
            res.send({ status: 'success', data: result });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message.startsWith('错误')) {
                res.send({ status: 'failed', data: message });
            } else {
                console.log(e);
                res.status(500).send({ status: 'failed', data: '内部错误' });
            }
        }
    }
);

export { router as songChartDataRouter };
