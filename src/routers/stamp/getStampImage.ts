import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { middleware } from '../middleware';
import { imageBuffer, stampUrl, assetCacheKey } from '../../data/assets';
import { storeFor } from '../../data/region';
import { fallbackChain, isServerInput, Server } from '../../types/Server';
import { isFuzzySearchResult, FuzzySearchResult } from '../../fuzzySearch';
import { searchStamps, allStamps, StampScope } from '../../data/stamps';
import { textToFuzzyResult } from '../../search';
import { drawStampList } from '../../view/stamp/stampList';

/**
 * 贴纸查询(单服回退)。三种用法:
 * - `stampId`            按数字 ID 直出官方贴纸**原图**(不加工)
 * - `text` / `fuzzySearchResult`  模糊搜索 -> **全部结果渲染进同一张列表图**(带 ID)
 * - 都不传               列出该服全部贴纸(列表图)
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
        // ID 数字与纯数字字符串都收
        body('stampId').optional().custom(v => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('stampType').optional().isIn(['all', 'character', 'band']),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { stampId, text, fuzzySearchResult, stampType, compress } = req.body;
        try {
            const servers = fallbackChain(req.body);
            const result = await commandGetStampImage(servers, {
                stampId: stampId === undefined ? undefined : parseInt(String(stampId), 10),
                text,
                fuzzySearchResult,
                scope: (stampType ?? 'all') as StampScope,
                compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface StampQuery {
    stampId?: number;
    text?: string;
    fuzzySearchResult?: FuzzySearchResult;
    scope: StampScope;
    compress: boolean;
}

export async function commandGetStampImage(servers: Server[], query: StampQuery): Promise<Array<Buffer | string>> {
    // 按 ID 直出原图: 沿回退链取第一个有该贴纸(且图片可取得)的服
    if (query.stampId !== undefined) {
        let found = false;
        for (const server of servers) {
            const store = storeFor(server);
            await store.refresh();
            const stamp = await store.stampById(query.stampId);
            if (!stamp) continue;
            found = true;
            if (!stamp.stampAsset) continue;
            const art = await imageBuffer(stampUrl(server, stamp.stampAsset), assetCacheKey(server, `stamp/${query.stampId}.webp`));
            if (!art) continue;
            return [art];
        }
        return [found ? '错误: 贴纸图片获取失败' : '错误: 该贴纸不存在'];
    }

    const keyword = typeof query.text === 'string' ? query.text : '';
    if (query.text && query.fuzzySearchResult) {
        return ['错误: text 与 fuzzySearchResult 不能同时存在'];
    }

    // 都不传: 列出链首服的全部贴纸
    if (!query.fuzzySearchResult && !keyword) {
        return drawStampList(servers[0], await allStamps(servers[0]), query.scope, keyword, query.compress);
    }

    // 模糊搜索: 沿回退链取第一个有搜索结果的服
    let hasKeyword = false;
    for (const server of servers) {
        const matches = query.fuzzySearchResult ?? await textToFuzzyResult(server, keyword);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const stamps = await searchStamps(server, matches, query.scope);
        if (stamps.length === 0) continue;
        return drawStampList(server, stamps, query.scope, keyword, query.compress);
    }
    return hasKeyword
        ? drawStampList(servers[0], [], query.scope, keyword, query.compress)
        : ['错误: 没有有效的关键词'];
}

export { router as getStampImageRouter };
