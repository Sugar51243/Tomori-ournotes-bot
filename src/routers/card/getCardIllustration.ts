import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput } from '../utils';
import { middleware } from '../middleware';
import { imageBuffer, cardFullArtUrl, supportCardFullUrl } from '../../data/assets';
import { isMemberCard, CardKind } from '../../search';
import { fallbackChain, isServerInput, Server, withServer } from '../../types/Server';
import { Card } from '../../types/Card';
import { SupportCard } from '../../types/SupportCard';
import { assetCacheKey } from '../../data/assets';

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

export interface CardIllustrationQuery {
    cardId: number;
    cardType?: CardKind;
}

export async function commandGetCardIllustration(servers: Server[], query: CardIllustrationQuery): Promise<Array<Buffer | string>> {
    const { cardId, cardType = 'auto' } = query;
    // 原图直出, 无法在一张图里表达多服差异 -> 沿回退链取第一个收录该卡的区域
    const kinds: Array<'member' | 'support'> = cardType === 'auto' ? ['member', 'support'] : [cardType];
    let card: Card | SupportCard | undefined;
    for (const server of servers) {
        for (const kind of kinds) {
            const candidate = kind === 'support'
                ? withServer(new SupportCard(cardId), server)
                : withServer(new Card(cardId), server);
            await candidate.init();
            if (candidate.isExist) { card = candidate; break; }
        }
        if (card) break;
    }
    if (!card) {
        return ['错误: 该卡不存在'];
    }
    const url = isMemberCard(card)
        ? cardFullArtUrl(card.server, card.cardId)
        : supportCardFullUrl(card.server, card.assetId);
    const key = assetCacheKey(card.server, isMemberCard(card) ? `card/${card.assetId}_full.png` : `support/${card.assetId}_full.png`);
    const art = await imageBuffer(url, key);
    if (!art) {
        return ['错误: 卡面图片获取失败'];
    }
    return [art];
}

export { router as getCardIllustrationRouter };
