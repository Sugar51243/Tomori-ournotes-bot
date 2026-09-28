import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { middleware } from './middleware';
import { imageBuffer, cardFullArtUrl, supportCardFullUrl } from '../data/assets';
import { resolveCard, isMemberCard, CardKind } from '../search';

/** 卡面原图(无画布加工): 支持成员卡(角色卡)与支援卡 */
const router = express.Router();

router.post(
    '/',
    [
        body('cardId').isNumeric(),
        // 卡片种类: member=角色卡, support=支援卡, auto=先按角色卡再按支援卡(默认)
        body('cardType').optional().isIn(['member', 'support', 'auto']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { cardId, cardType } = req.body;
        try {
            const result = await commandGetCardIllustration(parseInt(cardId, 10), cardType);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGetCardIllustration(cardId: number, cardType: CardKind = 'auto'): Promise<Array<Buffer | string>> {
    const card = await resolveCard(cardId, cardType);
    if (!card) {
        return ['错误: 该卡不存在'];
    }
    const member = isMemberCard(card);
    const url = member ? cardFullArtUrl(card.cardId) : supportCardFullUrl(card.assetId);
    const key = member ? `images/card/${card.assetId}_full.png` : `images/support/${card.assetId}_full.png`;
    const art = await imageBuffer(url, key);
    if (!art) {
        return ['错误: 卡面图片获取失败'];
    }
    return [art];
}

export { router as getCardIllustrationRouter };
