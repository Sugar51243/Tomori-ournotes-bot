import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput, EntityInput } from '../utils';
import { fallbackChain, isServerInput, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { Song } from '../../types/Song';
import { drawSongDetail } from '../../view/song/songDetail';
import { drawSongList } from '../../view/song/songList';
import { drawSongChart } from '../../view/song/songChart';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../../components/OurNotesPreview';
import { searchSongs, textToFuzzyResult } from '../../search';
import { firstOwnServer, firstServerHavingSong, songServerRows } from '../../data/serverInfo';

/**
 * 查歌(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`。
 * 传单个字段即可 —— 纯数字即按 ID 直查, 其它文本走模糊搜索, 不再需要先调 /fuzzySearch。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('songId').optional(),
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
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }

        try {
            const result = await commandSong(fallbackChain(req.body), {
                input,
                compress: req.body.compress,
                singleDraw: req.body.singleDraw,
                difficultyId: req.body.difficultyId,
                mirror: req.body.mirror,
                noteSpeed: req.body.noteSpeed ?? req.body.speed,
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface SongQuery {
    /** 查询输入: 数字/纯数字字符串=ID, 其它文本=模糊搜索, 或现成的模糊结果 */
    input: EntityInput;
    compress?: boolean;
    /** 模糊结果唯一命中时的出图方式: detail=歌曲详情(默认) / chart=该曲谱面图 */
    singleDraw?: 'detail' | 'chart';
    /** chart 模式: 难度(0-3, 默认3) / 镜像 / 预览流速(1.00~12.00, 默认5.00) */
    difficultyId?: number;
    mirror?: boolean;
    noteSpeed?: number;
}

export async function commandSong(servers: Server[], query: SongQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false } = query;
    if (typeof input === 'string' && isInteger(input)) {
        const songId = parseInt(input, 10);
        // singleDraw=chart: 按 ID 直查同样适用(与模糊唯一命中一致), 免得调用方为了出谱面图再换 /songChart
        if (query.singleDraw === 'chart') {
            const server = await firstServerHavingSong(songId, servers);
            if (!server) return ['错误: 歌曲不存在'];
            return drawSongChart(server, songId, query.difficultyId ?? 3, compress, query.mirror ?? false, query.noteSpeed ?? NOTE_SPEED_DEFAULT);
        }
        // 图内恒列全部四服; 主体按回退链取第一个收录该曲的服
        const rows = await songServerRows(songId, [...SERVER_LIST]);
        const bodyServer = firstOwnServer(rows, servers);
        if (!bodyServer) {
            return ['错误: 歌曲不存在'];
        }
        const song = withServer(new Song(songId), bodyServer);
        await song.init();
        return drawSongDetail(song, rows, compress);
    }

    const hit = await findSongMatches(servers, input);
    if ('error' in hit) return [hit.error];
    return finishSearchDraw(hit.server, hit.songs, compress, query);
}

/**
 * 文本/模糊结果在回退链上找歌曲候选: 沿链依次查, 取第一个有结果的服。
 * 搜索本身由 search.ts 保证 **ID > 自信息 > 关联** 的优先级(见 searchSongs)。
 */
export async function findSongMatches(
    servers: Server[],
    input: EntityInput
): Promise<{ server: Server; songs: Song[] } | { error: string }> {
    if (typeof input !== 'string') {
        // 调用方已给定模糊搜索结果: 直接在链首服的索引上匹配
        const server = servers[0];
        const songs = await searchSongs(server, input);
        return songs.length ? { server, songs } : { error: '没有搜索到符合条件的歌曲' };
    }
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const songs = await searchSongs(server, matches);
        if (songs.length === 0) continue;
        return { server, songs };
    }
    return { error: hasKeyword ? '没有搜索到符合条件的歌曲' : '错误: 没有有效的关键词' };
}

/** 搜索命中后的出图: 唯一命中出详情(或按 singleDraw 出谱面图), 多个命中出列表图 */
async function finishSearchDraw(bodyServer: Server, songs: Song[], compress: boolean, options: SongQuery): Promise<Array<Buffer | string>> {
    if (songs.length > 1) {
        return drawSongList(bodyServer, songs, compress);
    }
    // 唯一命中: 默认出歌曲详情(查曲); singleDraw=chart 时直接出该曲谱面图(查谱面)
    if (options.singleDraw === 'chart') {
        return drawSongChart(bodyServer, songs[0].songId, options.difficultyId ?? 3, compress, options.mirror ?? false, options.noteSpeed ?? NOTE_SPEED_DEFAULT);
    }
    const rows = await songServerRows(songs[0].songId, [...SERVER_LIST]);
    return drawSongDetail(songs[0], rows, compress);
}

export { router as searchSongRouter };
