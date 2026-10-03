import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { CardKind } from '../../search/search';
import { commandCard } from '../../features/card/cardRoute';

/**
 * 卡片查询路由工厂(单服回退)。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省)只决定**主体区块**用哪个服的语言与素材:
 * 按回退链依次查询, 取第一个收录该卡的服; 图内**恒列全部四服**的对比行。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `cardId` > `text` > `fuzzySearchResult`;
 * 纯数字按卡片 ID 直查, 其它文本走模糊搜索。
 *
 * 三套入口:
 * - /searchCard        整合(角色卡 + 支援卡)
 * - /searchMemberCard  仅角色卡(成员卡)
 * - /searchSupportCard 仅支援卡
 * 角色卡与支援卡 ID 空间重叠, 故按 ID 查询时以入口(cardType)区分。
 */

/**
 * 构建卡片查询路由。
 * @param kind 固定查询的卡片种类(member/support/auto)
 * @param acceptCardType 是否额外接受请求体中的 cardType 覆盖(整合入口用)
 */
export function createCardRouter(kind: CardKind, acceptCardType = false): express.Router {
    const router = express.Router();
    const validators = [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('cardId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        ...(acceptCardType ? [body('cardType').optional().isIn(['member', 'support', 'auto'])] : []),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ];

    router.post('/', validators, middleware, async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['cardId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / cardId / text / fuzzySearchResult 之一' });
        }
        try {
            const effectiveKind: CardKind = acceptCardType ? (req.body.cardType ?? kind) : kind;
            const result = await commandCard(fallbackChain(req.body), { input, compress: req.body.compress, cardType: effectiveKind });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    });

    return router;
}
