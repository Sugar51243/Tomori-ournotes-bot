import express from 'express';
import { body } from 'express-validator';
import { middleware } from './middleware';
import { textToFuzzyResult } from '../search';
import { ensureFuzzyIndex } from '../fuzzyIndex';
import { isServerList, pickServers } from '../types/Server';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerList),
        body('text').isString(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text } = req.body;
        try {
            // 索引按区域分片: 用服列表的第一个区域。注意后续 /searchSong 若换了另一个区域,
            // 匹配对象来自不同区域, 结果会退化为「没有搜索到」而不是报错。
            const server = pickServers(req.body)[0];
            await ensureFuzzyIndex(server);
            const result = textToFuzzyResult(server, text);
            res.send({ status: 'success', data: result });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as fuzzySearchRouter };
