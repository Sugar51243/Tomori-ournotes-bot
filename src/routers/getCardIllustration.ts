import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { middleware } from './middleware';
import { imageBuffer, cardFullArtUrl, supportCardFullUrl } from '../data/assets';
import { isMemberCard, CardKind } from '../search';
import { isServerList, pickServers, Server, withServer } from '../types/Server';
import { Card } from '../types/Card';
import { SupportCard } from '../types/SupportCard';
import { assetCacheKey } from '../data/assets';

/** 卡面原图(无画布加工): 支持成员卡(角色卡)与支援卡 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerList),
        body('cardId').isNumeric(),
        // 卡片种类: member=角色卡, support=支援卡, auto=先按角色卡再按支援卡(默认)
        body('cardType').optional().isIn(['member', 'support', 'auto']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { cardId, cardType } = req.body;
        try {
            const result = await commandGetCardIllustration(pickServers(req.body), parseInt(cardId, 10), cardType);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGetCardIllustration(servers: Server[], cardId: number, cardType: CardKind = 'auto'): Promise<Array<Buffer | string>> {
    // 原图直出, 无法在一张图里表达多服差异 -> 取第一个收录该卡的区域
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
