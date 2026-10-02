import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList, pickServers, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Band } from '../types/Band';
import { bandServerRows } from '../data/serverInfo';
import { drawBandDetail, drawBandList } from '../view/bandDetail';
import { searchBands, textToFuzzyResult } from '../search';

/**
 * 查乐团。
 *
 * 乐团是**静态游戏数据**: 多服一图(主体用「自己有该乐团」的服渲染, 下方附各服信息表)。
 * 支持数字 id、模糊搜索, 以及**自定义关键词**(关键词走 keyword/upload, 实体类型 `band`)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').custom(isServerList),
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
            const servers = pickServers(req.body);
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
        const rows = await bandServerRows(bandId, servers);
        // 主体必须用「自己有该乐团」的服: 借数据的行渲染不出乐团本身
        const bodyServer = rows.find(r => r.hasOwn)?.server;
        if (!bodyServer) return ['错误: 该乐团不存在'];
        const band = withServer(new Band(bandId), bodyServer);
        await band.init();
        if (!band.isExist) return ['错误: 该乐团不存在'];
        return drawBandDetail(band, rows, compress);
    }

    const bodyServer = servers[0];
    const matches = typeof input === 'string' ? await textToFuzzyResult(bodyServer, input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const bands = await searchBands(bodyServer, matches);
    if (bands.length === 0) return ['没有搜索到符合条件的乐团'];
    if (bands.length === 1) {
        const rows = await bandServerRows(bands[0].bandId, servers);
        return drawBandDetail(bands[0], rows, compress);
    }
    return drawBandList(bodyServer, bands, compress);
}

export { router as searchBandRouter };
