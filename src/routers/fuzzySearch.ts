import express from 'express';
import { body } from 'express-validator';
import { middleware } from './middleware';
import { textToFuzzyResult } from '../search';
import { ensureFuzzyIndex } from '../fuzzyIndex';

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
            await ensureFuzzyIndex();
            const result = textToFuzzyResult(text);
            res.send({ status: 'success', data: result });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as fuzzySearchRouter };
