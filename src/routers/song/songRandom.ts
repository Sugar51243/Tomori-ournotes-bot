import express from 'express';
import { body } from 'express-validator';
import { listToBase64, pickEntityInput, EntityInput } from '../utils';
import { isServerInput, pickServers, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { searchSongs, textToFuzzyResult } from '../../search';
import { drawSongRandom } from '../../view/song/songRandom';

/**
 * 随机歌曲(多服)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 一个都不传时从全部歌曲里随机。文本命中多首时在命中集合里随机。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('id').optional(),
        body('songId').optional(),
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandSongRandom(pickServers(req.body), {
                input: pickEntityInput(req.body, ['songId']),
                compress: req.body.compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface SongRandomQuery {
    /** 不传 = 从全部歌曲随机 */
    input?: EntityInput;
    compress?: boolean;
}

export async function commandSongRandom(servers: Server[], query: SongRandomQuery): Promise<Array<Buffer | string>> {
    const server = servers[0];
    let candidates;
    if (query.input === undefined) {
        candidates = await searchSongs(server, {});
    } else if (typeof query.input === 'string') {
        candidates = await searchSongs(server, await textToFuzzyResult(server, query.input));
    } else {
        candidates = await searchSongs(server, query.input);
    }
    return drawSongRandom(candidates, servers, query.compress ?? false);
}

export { router as songRandomRouter };
