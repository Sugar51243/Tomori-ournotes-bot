import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput } from '../utils';
import { isServerInput, pickServer, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Song } from '../../types/Song';
import { getMusicRanking } from '../../data/ranking/client';
import { drawSongRanking } from '../../view/song/songRanking';
import { drawSongList } from '../../view/song/songList';
import { findSongMatches } from './searchSong';

/**
 * 歌曲排行榜(前十用户与出分)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 传文本时只在该服的索引里搜索(数据本身只属于这一个服, 不跨服回退)。
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
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }
        try {
            const server = pickServer(req.body);
            const compress = req.body.compress;

            // 文字搜索: 只在该服的索引里找(唯一命中直接用, 多命中出歌曲列表图)
            let songId: number;
            if (typeof input === 'string' && isInteger(input)) {
                songId = parseInt(input, 10);
            } else {
                const hit = await findSongMatches([server], input);
                if ('error' in hit) return res.send(listToBase64([hit.error]));
                if (hit.songs.length > 1) return res.send(listToBase64(await drawSongList(server, hit.songs, compress)));
                songId = hit.songs[0].songId;
            }

            const result = await commandSongRanking(server, { songId, compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface SongRankingQuery {
    songId: number;
    compress?: boolean;
}

export async function commandSongRanking(server: Server, query: SongRankingQuery): Promise<Array<Buffer | string>> {
    const { songId, compress = false } = query;
    const song = withServer(new Song(songId), server);
    await song.init();
    if (!song.isExist) {
        return ['错误: 歌曲不存在'];
    }
    const ranking = await getMusicRanking(server, songId, 10);
    return drawSongRanking(server, songId, song.musicTitle, ranking, compress);
}

export { router as songRankingRouter };
