import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { drawCardDetail } from '../view/cardDetail';
import { drawCardList } from '../view/cardList';
import { searchCards, textToFuzzyResult, resolveCard, CardKind } from '../search';

/**
 * 卡片查询的公共实现与路由工厂。
 * 三套入口:
 * - /searchCard        整合(角色卡 + 支援卡)
 * - /searchMemberCard  仅角色卡(成员卡)
 * - /searchSupportCard 仅支援卡
 * 角色卡与支援卡 ID 空间重叠, 故按 ID 查询时以入口(cardType)区分。
 */
export async function commandCard(input: string | FuzzySearchResult, compress: boolean, cardType: CardKind = 'auto'): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const card = await resolveCard(parseInt(input, 10), cardType);
        if (!card) {
            return ['错误: 该卡不存在'];
        }
        return drawCardDetail(card, compress);
    }
    const matches = typeof input === 'string' ? textToFuzzyResult(input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const cards = await searchCards(matches, cardType);
    if (cards.length === 0) {
        return ['错误: 没有搜索到符合条件的卡牌'];
    }
    if (cards.length === 1) {
        return drawCardDetail(cards[0], compress);
    }
    return drawCardList(cards, compress);
}

/**
 * 构建卡片查询路由。
 * @param kind 固定查询的卡片种类(member/support/auto)
 * @param acceptCardType 是否额外接受请求体中的 cardType 覆盖(整合入口用)
 */
export function createCardRouter(kind: CardKind, acceptCardType = false): express.Router {
    const router = express.Router();
    const validators = [
        body('displayedServerList').custom(isServerList),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        ...(acceptCardType ? [body('cardType').optional().isIn(['member', 'support', 'auto'])] : []),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ];

    router.post('/', validators, middleware, async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, cardType, compress } = req.body;
        if (text && fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: 'text 与 fuzzySearchResult 不能同时存在' });
        }
        if (!text && !fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: '不能同时不存在 text 与 fuzzySearchResult' });
        }
        try {
            const effectiveKind: CardKind = acceptCardType ? (cardType ?? kind) : kind;
            const result = await commandCard(text || fuzzySearchResult, compress, effectiveKind);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    });

    return router;
}
