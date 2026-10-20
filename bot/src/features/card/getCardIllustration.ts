import { imageBuffer, cardFullArtUrl, supportCardFullUrl, assetCacheKey } from '../../upstream/adapter';
import { isMemberCard, CardKind } from '../../search/search';
import { Server, withServer } from '../types/Server';
import { Card } from '../types/Card';
import { SupportCard } from '../types/SupportCard';

/**
 * 卡面原图(无画布加工)的功能实现: 支持成员卡(角色卡)与支援卡; 单服回退, 取回退链上第一个收录该卡的服。
 *
 * 输入是**卡片 ID**(`id` / `cardId` 都收, 数字或纯数字字符串) —— 原图没有「多命中列表」
 * 的表达方式, 所以这里不做文本搜索, 按名字查卡请用 /searchCard。
 */
export interface CardIllustrationQuery {
    cardId: number;
    cardType?: CardKind;
}

/** 卡面原图入口: 沿回退链找第一个收录该卡的服, 直出原图(不加工) */
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
