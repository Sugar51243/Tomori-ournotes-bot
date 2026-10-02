import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from '../utils';
import { fallbackChain, isServerInput, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../../fuzzySearch';
import { Gacha } from '../../types/Gacha';
import { textToFuzzyResult, searchGachas } from '../../search';
import { drawGachaDetail } from '../../view/gacha/gachaDetail';
import { drawGachaList } from '../../view/gacha/gachaList';

/**
 * 查卡池(单服回退)。支持数字 ID 与模糊搜索:
 * 搜索按 **ID > 自信息 > 关联** 优先(卡片/乐团/角色/活动 -> 卡池), 多命中出卡池列表图。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('gachaId').optional().isInt(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { gachaId, text, fuzzySearchResult, compress } = req.body;
        const provided = [gachaId !== undefined, text !== undefined, fuzzySearchResult !== undefined].filter(Boolean).length;
        if (provided !== 1) {
            return res.status(422).json({ status: 'failed', data: 'gachaId 与 text / fuzzySearchResult 需且只能提供一个' });
        }
        try {
            const servers = fallbackChain(req.body);
            const directId = gachaId !== undefined ? Number(gachaId)
                : (typeof text === 'string' && isInteger(text) ? parseInt(text, 10) : undefined);
            if (directId !== undefined) {
                return res.send(listToBase64(await commandGacha(servers, directId, compress)));
            }
            const hit = await findGachaMatches(servers, text ?? fuzzySearchResult);
            if ('error' in hit) {
                return res.send(listToBase64([hit.error]));
            }
            if (hit.gachas.length > 1) {
                return res.send(listToBase64(await drawGachaList(hit.server, hit.gachas, compress)));
            }
            return res.send(listToBase64(await drawGachaDetail(hit.gachas[0], compress)));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGacha(servers: Server[], gachaId: number, compress: boolean): Promise<Array<Buffer | string>> {
    // 单服回退: 主体取回退链上第一个收录该卡池的区域
    let gacha: Gacha | undefined;
    for (const server of servers) {
        const candidate = withServer(new Gacha(gachaId), server);
        await candidate.init();
        if (candidate.isExist) { gacha = candidate; break; }
    }
    if (!gacha) {
        return ['错误: 该卡池不存在'];
    }
    return drawGachaDetail(gacha, compress);
}

/** 文本/模糊结果在回退链上找卡池候选: 沿链依次查, 取第一个有结果的服 */
async function findGachaMatches(
    servers: Server[],
    input: string | FuzzySearchResult
): Promise<{ server: Server; gachas: Gacha[] } | { error: string }> {
    if (typeof input !== 'string') {
        const server = servers[0];
        const gachas = await searchGachas(server, input);
        return gachas.length ? { server, gachas } : { error: '没有搜索到符合条件的卡池' };
    }
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const gachas = await searchGachas(server, matches);
        if (gachas.length === 0) continue;
        return { server, gachas };
    }
    return { error: hasKeyword ? '没有搜索到符合条件的卡池' : '错误: 没有有效的关键词' };
}

export { router as searchGachaRouter };
