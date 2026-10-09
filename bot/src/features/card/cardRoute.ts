import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { SERVER_LIST, Server, withServer } from '../types/Server';
import { drawCardDetail } from '../../render/view/card/cardDetail';
import { drawCardList } from '../../render/view/card/cardList';
import { searchCards, textToFuzzyResult, isMemberCard, CardKind, AnyCard } from '../../search/search';
import { cardServerRows, firstOwnServer } from '../../db/adapter';
import { Card } from '../types/Card';
import { SupportCard } from '../types/SupportCard';

/**
 * 卡片查询的功能实现(单服回退)。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省)只决定**主体区块**用哪个服的语言与素材:
 * 按回退链依次查询, 取第一个收录该卡的服; 图内**恒列全部四服**的对比行。
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput): `id` > `cardId` > `text` > `fuzzySearchResult`;
 * 纯数字按卡片 ID 直查, 其它文本走模糊搜索。
 *
 * 三套入口(路由见 routers/card/cardRoute.ts):
 * - /searchCard        整合(角色卡 + 支援卡)
 * - /searchMemberCard  仅角色卡(成员卡)
 * - /searchSupportCard 仅支援卡
 * 角色卡与支援卡 ID 空间重叠, 故按 ID 查询时以入口(cardType)区分。
 */
export interface CardQuery {
    input: EntityInput;
    compress?: boolean;
    cardType?: CardKind;
}

/** 查卡入口: ID 直查(先成员卡后支援卡)/ 文本模糊(多命中列表图, 唯一命中详情图) */
export async function commandCard(servers: Server[], query: CardQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false, cardType = 'auto' } = query;
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
