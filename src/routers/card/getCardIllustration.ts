import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandGetCardIllustration } from '../../features/card/getCardIllustration';

/**
 * 卡面原图(无画布加工): 支持成员卡(角色卡)与支援卡; 单服回退, 取回退链上第一个收录该卡的服。
 *
 * 输入是**卡片 ID**(`id` / `cardId` 都收, 数字或纯数字字符串) —— 原图没有「多命中列表」
 * 的表达方式, 所以这里不做文本搜索, 按名字查卡请用 /searchCard。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('cardId').optional(),
        // 卡片种类: member=角色卡, support=支援卡, auto=先按角色卡再按支援卡(默认)
        body('cardType').optional().isIn(['member', 'support', 'auto']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['cardId']);
        if (typeof input !== 'string' || !isInteger(input)) {
            return res.status(400).send({ status: 'failed', data: '参数错误', error: [{ msg: '需要提供数字卡片 ID: id / cardId' }] });
        }
        try {
            const result = await commandGetCardIllustration(fallbackChain(req.body), {
                cardId: parseInt(input, 10),
                cardType: req.body.cardType
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as getCardIllustrationRouter };
