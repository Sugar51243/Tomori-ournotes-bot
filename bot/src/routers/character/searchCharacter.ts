import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandCharacter } from '../../features/character/searchCharacter';

/**
 * 查角色(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `characterId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按角色 ID 直查, 其它文本走模糊搜索。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('characterId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['characterId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / characterId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandCharacter(fallbackChain(req.body), { input, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as searchCharacterRouter };
