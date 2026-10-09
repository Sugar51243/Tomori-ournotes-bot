import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import type { StampScope } from '../../db/adapter';
import { commandGetStampImage } from '../../features/stamp/getStampImage';

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

export { router as getStampImageRouter };
