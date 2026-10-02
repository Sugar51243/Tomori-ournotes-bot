import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../../fuzzySearch';
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
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, compress } = req.body;

        if (text && fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: 'text 与 fuzzySearchResult 不能同时存在' });
        }
        if (!text && !fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: '不能同时不存在 text 与 fuzzySearchResult' });
        }

        try {
            const servers = fallbackChain(req.body);
            const result = await commandBand(servers, text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandBand(servers: Server[], input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
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
