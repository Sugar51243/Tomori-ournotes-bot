import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList, pickServers, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Song } from '../types/Song';
import { drawSongDetail } from '../view/songDetail';
import { drawSongList } from '../view/songList';
import { searchSongs, textToFuzzyResult } from '../search';
import { songServerRows } from '../data/serverInfo';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').custom(isServerList),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('text').optional().isString(),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, compress } = req.body;

        if (text && fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: 'text 与 fuzzySearchResult 不能同时存在' });
        }
        if (!text && !fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: '不能同时不存在 text 与 fuzzySearchResult' });
        }

        try {
            const servers = pickServers(req.body);
            const result = await commandSong(servers, text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSong(servers: Server[], input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        const songId = parseInt(input, 10);
        const rows = await songServerRows(songId, servers);
        // 主体用服列表里「自己收录了这首歌」的第一个服渲染; 其余服以行形式附在下方
        const bodyServer = rows.find(r => r.hasOwn)?.server;
        if (!bodyServer) {
            return ['错误: 歌曲不存在'];
        }
        const song = withServer(new Song(songId), bodyServer);
        await song.init();
        return drawSongDetail(song, rows, compress);
    }
    // 列表查询: 主体区域按服列表顺序取第一个
    const bodyServer = servers[0];
    const matches = typeof input === 'string' ? await textToFuzzyResult(bodyServer, input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const songs = await searchSongs(bodyServer, matches);
    if (songs.length === 0) {
        return ['没有搜索到符合条件的歌曲'];
    }
    if (songs.length === 1) {
        const rows = await songServerRows(songs[0].songId, servers);
        return drawSongDetail(songs[0], rows, compress);
    }
    return drawSongList(bodyServer, songs, compress);
}

export { router as searchSongRouter };
