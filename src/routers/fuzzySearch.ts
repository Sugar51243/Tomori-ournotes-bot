import express from 'express';
import { body } from 'express-validator';
import { middleware } from './middleware';
import { textToFuzzyResult } from '../search';
import { defaultServer } from '../types/Server';

const router = express.Router();

router.post(
    '/',
    [
        body('text').isString(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text } = req.body;
        try {
            // 模糊搜索不需要服务器参数, 索引固定用缺省区域
            const server = defaultServer();
            const result = await textToFuzzyResult(server, text);
            res.send({ status: 'success', data: result });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as fuzzySearchRouter };
