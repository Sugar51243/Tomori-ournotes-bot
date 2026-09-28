import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServer } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult } from '../fuzzySearch';
import { searchSongs, textToFuzzyResult } from '../search';
import { drawSongRandom } from '../view/songRandom';

const router = express.Router();

router.post(
    '/',
    [
        body('mainServer').custom(isServer),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, compress } = req.body;
        try {
            let candidates;
            if (fuzzySearchResult) {
                candidates = await searchSongs(fuzzySearchResult);
            } else if (text) {
                candidates = await searchSongs(textToFuzzyResult(text));
            } else {
                candidates = await searchSongs({});
            }
            const result = await drawSongRandom(candidates, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as songRandomRouter };
