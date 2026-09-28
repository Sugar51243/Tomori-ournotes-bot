import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Song } from '../types/Song';
import { drawSongDetail } from '../view/songDetail';
import { drawSongList } from '../view/songList';
import { searchSongs, textToFuzzyResult } from '../search';

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
            const result = await commandSong(text || fuzzySearchResult, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSong(input: string | FuzzySearchResult, compress: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string') {
        if (isInteger(input)) {
            const song = new Song(parseInt(input, 10));
            await song.init();
            if (!song.isExist) {
                return ['错误: 歌曲不存在'];
            }
            return drawSongDetail(song, compress);
        }
    }
    const matches = typeof input === 'string' ? textToFuzzyResult(input) : input;
    if (Object.keys(matches).length == 0) {
        return ['错误: 没有有效的关键词'];
    }
    const songs = await searchSongs(matches);
    if (songs.length === 0) {
        return ['没有搜索到符合条件的歌曲'];
    }
    if (songs.length === 1) {
        return drawSongDetail(songs[0], compress);
    }
    return drawSongList(songs, compress);
}

export { router as searchSongRouter };
