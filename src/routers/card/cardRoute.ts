import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../../fuzzySearch';
import { drawCardDetail } from '../../view/card/cardDetail';
import { drawCardList } from '../../view/card/cardList';
import { searchCards, textToFuzzyResult, isMemberCard, CardKind, AnyCard } from '../../search';
import { cardServerRows, firstOwnServer } from '../../data/serverInfo';
import { Card } from '../../types/Card';
import { SupportCard } from '../../types/SupportCard';

/**
 * 卡片查询的公共实现与路由工厂(单服回退)。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省)只决定**主体区块**用哪个服的语言与素材:
 * 按回退链依次查询, 取第一个收录该卡的服; 图内**恒列全部四服**的对比行。
 *
 * 三套入口:
 * - /searchCard        整合(角色卡 + 支援卡)
 * - /searchMemberCard  仅角色卡(成员卡)
 * - /searchSupportCard 仅支援卡
 * 角色卡与支援卡 ID 空间重叠, 故按 ID 查询时以入口(cardType)区分。
 */
export async function commandCard(servers: Server[], input: string | FuzzySearchResult, compress: boolean, cardType: CardKind = 'auto'): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const cardId = parseInt(input, 10);
        // auto: 先角色卡后支援卡; 图内恒列全部四服, 主体按回退链取首个收录该卡的服
        const kinds: Array<'member' | 'support'> = cardType === 'auto' ? ['member', 'support'] : [cardType];
        for (const kind of kinds) {
            const rows = await cardServerRows(cardId, kind, [...SERVER_LIST]);
            const bodyServer = firstOwnServer(rows, servers);
            if (!bodyServer) continue;
            const card: AnyCard = kind === 'support'
                ? withServer(new SupportCard(cardId), bodyServer)
                : withServer(new Card(cardId), bodyServer);
            await card.init();
            if (!card.isExist) continue;
            return drawCardDetail(card, rows, compress);
        }
        return ['错误: 该卡不存在'];
    }

    if (typeof input !== 'string') {
        const bodyServer = servers[0];
        const cards = await searchCards(bodyServer, input, cardType);
        if (cards.length === 0) return ['错误: 没有搜索到符合条件的卡牌'];
        return finishSearchDraw(bodyServer, cards, compress);
    }

    // 文本: 沿回退链依次查各服的模糊索引, 取第一个有结果的服
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const cards = await searchCards(server, matches, cardType);
        if (cards.length === 0) continue;
        return finishSearchDraw(server, cards, compress);
    }
    return hasKeyword ? ['错误: 没有搜索到符合条件的卡牌'] : ['错误: 没有有效的关键词'];
}

/** 搜索命中后的出图: 唯一命中出详情, 多个命中出列表图 */
async function finishSearchDraw(bodyServer: Server, cards: AnyCard[], compress: boolean): Promise<Array<Buffer | string>> {
    if (cards.length > 1) {
        return drawCardList(bodyServer, cards, compress);
    }
    const card = cards[0];
    const member = isMemberCard(card);
    const rows = await cardServerRows(member ? card.cardId : card.supportCardId, member ? 'member' : 'support', [...SERVER_LIST]);
    return drawCardDetail(card, rows, compress);
}

/**
 * 构建卡片查询路由。
 * @param kind 固定查询的卡片种类(member/support/auto)
 * @param acceptCardType 是否额外接受请求体中的 cardType 覆盖(整合入口用)
 */
export function createCardRouter(kind: CardKind, acceptCardType = false): express.Router {
    const router = express.Router();
    const validators = [
        body('displayedServerList').optional().custom(isServerInput),
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
            const servers = fallbackChain(req.body);
            const result = await commandCard(servers, text || fuzzySearchResult, compress, effectiveKind);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    });

    return router;
}
