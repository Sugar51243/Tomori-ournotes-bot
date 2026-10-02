import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { middleware } from '../middleware';
import { imageBuffer, stampUrl, assetCacheKey } from '../../data/assets';
import { storeFor } from '../../data/region';
import { fallbackChain, isServerInput, Server } from '../../types/Server';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { searchStamps, allStamps, StampScope } from '../../data/stamps';
import { textToFuzzyResult } from '../../search';
import { drawStampList } from '../../view/stamp/stampList';

/**
 * 贴纸查询(单服回退)。三种用法:
 * - 数字 ID               按 `id` / `stampId` 直出官方贴纸**原图**(不加工)
 * - 文本 / 模糊搜索结果    模糊搜索 -> **全部结果渲染进同一张列表图**(带 ID)
 * - 都不传                列出该服全部贴纸(列表图)
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `stampId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按 ID 直查, 其它文本走模糊搜索。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省): 沿回退链取第一个收录该贴纸(有搜索结果)的服。
 *
 * 关键词可落在三个维度, 由 `stampType` 决定只认哪一类名称:
 * - `all`(默认)  贴纸名 / 角色名 / 团体名 都认
 * - `character`  只认角色名
 * - `band`       只认团体名
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('stampId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('stampType').optional().isIn(['all', 'character', 'band']),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandGetStampImage(fallbackChain(req.body), {
                input: pickEntityInput(req.body, ['stampId']),
                scope: (req.body.stampType ?? 'all') as StampScope,
                compress: req.body.compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface StampQuery {
    /** 不传 = 列出该服全部贴纸 */
    input?: EntityInput;
    scope: StampScope;
    compress?: boolean;
}

export async function commandGetStampImage(servers: Server[], query: StampQuery): Promise<Array<Buffer | string>> {
    const { input, scope, compress = false } = query;
    const stampId = typeof input === 'string' && isInteger(input) ? parseInt(input, 10) : undefined;

    // 按 ID 直出原图: 沿回退链取第一个有该贴纸(且图片可取得)的服
    if (stampId !== undefined) {
        let found = false;
        for (const server of servers) {
            const store = storeFor(server);
            await store.refresh();
            const stamp = await store.stampById(stampId);
            if (!stamp) continue;
            found = true;
            if (!stamp.stampAsset) continue;
            const art = await imageBuffer(stampUrl(server, stamp.stampAsset), assetCacheKey(server, `stamp/${stampId}.webp`));
            if (!art) continue;
            return [art];
        }
        return [found ? '错误: 贴纸图片获取失败' : '错误: 该贴纸不存在'];
    }

    // 都不传: 列出链首服的全部贴纸
    if (input === undefined) {
        return drawStampList(servers[0], await allStamps(servers[0]), scope, '', compress);
    }

    // 模糊搜索: 沿回退链取第一个有搜索结果的服
    const keyword = typeof input === 'string' ? input : '';
    let hasKeyword = false;
    for (const server of servers) {
        const matches = typeof input === 'string' ? await textToFuzzyResult(server, input) : input;
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const stamps = await searchStamps(server, matches, scope);
        if (stamps.length === 0) continue;
        return drawStampList(server, stamps, scope, keyword, compress);
    }
    return hasKeyword
        ? drawStampList(servers[0], [], scope, keyword, compress)
        : ['错误: 没有有效的关键词'];
}

export { router as getStampImageRouter };
