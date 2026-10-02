import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from './utils';
import { isServerList, pickServers, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { isFuzzySearchResult, FuzzySearchResult } from '../fuzzySearch';
import { Song } from '../types/Song';
import { drawSongDetail } from '../view/songDetail';
import { drawSongList } from '../view/songList';
import { drawSongChart } from '../view/songChart';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../components/OurNotesPreview';
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
        // 模糊结果唯一命中时的出图方式: detail=歌曲详情(默认, 查曲调用方) / chart=直接出该曲谱面图(查谱面调用方)。
        // chart 模式下 difficultyId/mirror/noteSpeed(或同义 speed) 透传给谱面渲染; 多结果时始终出列表图。
        body('singleDraw').optional().isIn(['detail', 'chart']),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('mirror').optional().isBoolean(),
        body('noteSpeed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
        body('speed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { text, fuzzySearchResult, compress, singleDraw, difficultyId, mirror, noteSpeed, speed } = req.body;

        if (text && fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: 'text 与 fuzzySearchResult 不能同时存在' });
        }
        if (!text && !fuzzySearchResult) {
            return res.status(422).json({ status: 'failed', data: '不能同时不存在 text 与 fuzzySearchResult' });
        }

        try {
            const servers = pickServers(req.body);
            const result = await commandSong(servers, text || fuzzySearchResult, compress, {
                singleDraw,
                difficultyId,
                mirror,
                noteSpeed: noteSpeed ?? speed,
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface SongDrawOptions {
    /** 模糊结果唯一命中时的出图方式: detail=歌曲详情(默认) / chart=该曲谱面图 */
    singleDraw?: 'detail' | 'chart';
    /** chart 模式: 难度(0-3, 默认3) / 镜像 / 预览流速(1.00~12.00, 默认5.00) */
    difficultyId?: number;
    mirror?: boolean;
    noteSpeed?: number;
}

export async function commandSong(servers: Server[], input: string | FuzzySearchResult, compress: boolean, options: SongDrawOptions = {}): Promise<Array<Buffer | string>> {
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
        // 唯一命中: 默认出歌曲详情(查曲); singleDraw=chart 时直接出该曲谱面图(查谱面)
        if (options.singleDraw === 'chart') {
            return drawSongChart(bodyServer, songs[0].songId, options.difficultyId ?? 3, compress, options.mirror ?? false, options.noteSpeed ?? NOTE_SPEED_DEFAULT);
        }
        const rows = await songServerRows(songs[0].songId, servers);
        return drawSongDetail(songs[0], rows, compress);
    }
    return drawSongList(bodyServer, songs, compress);
}

export { router as searchSongRouter };
