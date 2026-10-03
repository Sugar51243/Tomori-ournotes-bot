import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput } from '../utils';
import { isServerInput, pickServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../search/fuzzySearch';
import { commandGachaSimulate } from '../../features/gacha/gachaSimulate';

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

export { router as gachaSimulateRouter };
