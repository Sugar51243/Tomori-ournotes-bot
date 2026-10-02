import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { isServerInput, pickServer, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Gacha } from '../../types/Gacha';
import { simulateGacha, getCurrentGacha } from '../../gacha/simulate';
import { drawGachaSimulate } from '../../view/gacha/gachaSimulate';
import { findGachaMatches } from './searchGacha';

/**
 * 抽卡模拟(单服)。
 *
 * 卡池输入: `id` > `gachaId` > `text` > `fuzzySearchResult`, 一个都不传时取该服当前开放卡池;
 * 传文本时只在该服索引里搜索(数据本身只属于这一个服)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('gachaId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('times').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandGachaSimulate(pickServer(req.body), {
                input: pickEntityInput(req.body, ['gachaId']),
                times: req.body.times,
                compress: req.body.compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface GachaSimulateQuery {
    /** 不传 = 该服当前开放卡池 */
    input?: EntityInput;
    times?: number;
    compress?: boolean;
}

export async function commandGachaSimulate(server: Server, query: GachaSimulateQuery = {}): Promise<Array<Buffer | string>> {
    const { input, times = 10, compress = false } = query;
    if (times > 10000) {
        return ['错误: 抽卡次数过多, 请不要超过10000次'];
    }

    let gacha: Gacha | undefined;
    if (input === undefined) {
        gacha = await getCurrentGacha(server);
        if (!gacha) {
            return ['错误: 该服务器没有正在进行的卡池'];
        }
    } else if (typeof input === 'string' && isInteger(input)) {
        gacha = withServer(new Gacha(parseInt(input, 10)), server);
        await gacha.init();
        if (!gacha.isExist) {
            return ['错误: 该卡池不存在'];
        }
    } else {
        // 文本: 只在该服的索引里搜索, 唯一命中才取用
        const hit = await findGachaMatches([server], input);
        if ('error' in hit) return [hit.error];
        if (hit.gachas.length > 1) {
            const names = hit.gachas.slice(0, 5).map(g => `${g.gachaId} ${g.gachaName}`).join(' / ');
            return [`错误: 匹配到多个卡池, 请用 gachaId 精确指定: ${names}`];
        }
        gacha = hit.gachas[0];
    }

    const results = await simulateGacha(gacha, times);
    return drawGachaSimulate(gacha.gachaName, results, compress);
}

export { router as gachaSimulateRouter };
