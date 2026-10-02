import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Band } from '../../types/Band';
import { bandServerRows, firstOwnServer } from '../../data/serverInfo';
import { drawBandDetail, drawBandList } from '../../view/band/bandDetail';
import { searchBands, textToFuzzyResult } from '../../search';

/**
 * 查乐团(单服回退)。
 *
 * 服务器输入 `displayedServerList`(单个或列表, 可缺省)只决定**主体区块**用哪个服的语言与素材:
 * 按回退链依次查询, 取第一个收录该乐团的服; 图内**恒列全部四服**的对比行。
 * 支持数字 id、模糊搜索, 以及**自定义关键词**(关键词走 keyword/upload, 实体类型 `band`)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `bandId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按乐团 ID 直查, 其它文本走模糊搜索。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('bandId').optional(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['bandId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / bandId / text / fuzzySearchResult 之一' });
        }
        try {
            const result = await commandBand(fallbackChain(req.body), { input, compress: req.body.compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface BandQuery {
    input: EntityInput;
    compress?: boolean;
}

export async function commandBand(servers: Server[], query: BandQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false } = query;
    if (typeof input === 'string' && isInteger(input)) {
        const bandId = parseInt(input, 10);
        // 图内恒列全部四服; 主体按回退链取第一个收录该乐团的服
        const rows = await bandServerRows(bandId, [...SERVER_LIST]);
        const bodyServer = firstOwnServer(rows, servers);
        if (!bodyServer) return ['错误: 该乐团不存在'];
        const band = withServer(new Band(bandId), bodyServer);
        await band.init();
        if (!band.isExist) return ['错误: 该乐团不存在'];
        return drawBandDetail(band, rows, compress);
    }

    if (typeof input !== 'string') {
        // 调用方已给定模糊搜索结果: 直接在链首服的索引上匹配
        const bodyServer = servers[0];
        const bands = await searchBands(bodyServer, input);
        if (bands.length === 0) return ['没有搜索到符合条件的乐团'];
        if (bands.length === 1) {
            return drawBandDetail(bands[0], await bandServerRows(bands[0].bandId, [...SERVER_LIST]), compress);
        }
        return drawBandList(bodyServer, bands, compress);
    }

    // 文本: 沿回退链依次查各服的模糊索引, 取第一个有结果的服
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const bands = await searchBands(server, matches);
        if (bands.length === 0) continue;
        if (bands.length === 1) {
            return drawBandDetail(bands[0], await bandServerRows(bands[0].bandId, [...SERVER_LIST]), compress);
        }
        return drawBandList(server, bands, compress);
    }
    return hasKeyword ? ['没有搜索到符合条件的乐团'] : ['错误: 没有有效的关键词'];
}

export { router as searchBandRouter };
