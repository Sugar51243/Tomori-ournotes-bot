import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandGacha } from '../../features/gacha/searchGacha';

/**
 * 查卡池(单服回退)。支持数字 ID 与模糊搜索:
 * 搜索按 **ID > 自信息 > 关联** 优先(卡片/乐团/角色/活动 -> 卡池), 多命中出卡池列表图。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `gachaId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按卡池 ID 直查, 其它文本走模糊搜索。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('gachaId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['gachaId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / gachaId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandGacha(fallbackChain(req.body), { input, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as searchGachaRouter };
