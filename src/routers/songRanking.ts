import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServer, pickServer, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { Song } from '../types/Song';
import { getMusicRanking } from '../data/ranking/client';
import { drawSongRanking } from '../view/songRanking';

/**
 * 歌曲排行榜(前十用户与出分)。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器由单值 `server` 指定(兼容 tsugu 的 `mainServer`)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('server').optional().custom(isServer),
        body('mainServer').optional().custom(isServer),
        body('songId').isInt(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { songId, compress } = req.body;
        try {
            const result = await commandSongRanking(pickServer(req.body), parseInt(String(songId), 10), compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSongRanking(server: Server, songId: number, compress: boolean): Promise<Array<Buffer | string>> {
    const song = withServer(new Song(songId), server);
    await song.init();
    if (!song.isExist) {
        return ['错误: 歌曲不存在'];
    }
    const ranking = await getMusicRanking(server, songId, 10);
    return drawSongRanking(server, songId, song.musicTitle, ranking, compress);
}

export { router as songRankingRouter };
