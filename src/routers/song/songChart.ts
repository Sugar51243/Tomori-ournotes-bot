import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64 } from '../utils';
import { fallbackChain, isServerInput, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { drawSongChart } from '../../view/song/songChart';
import { drawSongList } from '../../view/song/songList';
import { firstServerHavingSong } from '../../data/serverInfo';
import { findSongMatches } from './searchSong';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../../components/OurNotesPreview';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('songId').optional().isInt(),
        // 文字搜索(与 songId 三选一): 唯一命中出该曲谱面图, 多命中出歌曲列表图
        body('text').optional().isString(),
        body('fuzzySearchResult').optional().custom(isFuzzySearchResult),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('compress').optional().isBoolean(),
        body('mirror').optional().isBoolean(),
        // 预览流速(音符速度): 沿用来源的 NoteSpeed 规则(默认 5.00, 范围 1.00~12.00),
        // 数值越高谱面拉得越长、音符间距越大。speed 为同义别名。
        body('noteSpeed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
        body('speed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { songId, text, fuzzySearchResult, difficultyId = 3, compress, mirror = false, noteSpeed, speed } = req.body;
        const resolvedSpeed = noteSpeed ?? speed ?? NOTE_SPEED_DEFAULT;
        const provided = [songId !== undefined, text !== undefined, fuzzySearchResult !== undefined].filter(Boolean).length;
        if (provided !== 1) {
            return res.status(422).json({ status: 'failed', data: 'songId 与 text / fuzzySearchResult 需且只能提供一个' });
        }
        try {
            const servers = fallbackChain(req.body);

            // 数字 ID(直接传或用数字文本) -> 直查
            const directId = songId !== undefined ? Number(songId)
                : (typeof text === 'string' && isInteger(text) ? parseInt(text, 10) : undefined);
            if (directId !== undefined) {
                return sendChart(res, servers, directId, difficultyId, compress, mirror, resolvedSpeed);
            }

            // 文字搜索: 沿回退链找候选(ID > 自信息 > 关联由 search 层保证)
            const hit = await findSongMatches(servers, text ?? fuzzySearchResult);
            if ('error' in hit) {
                return res.send(listToBase64([hit.error]));
            }
            // 多命中 -> 歌曲列表图; 唯一命中 -> 该曲谱面图
            if (hit.songs.length > 1) {
                const list = await drawSongList(hit.server, hit.songs, compress);
                return res.send(listToBase64(list));
            }
            return sendChart(res, servers, hit.songs[0].songId, difficultyId, compress, mirror, resolvedSpeed);
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

/** 单服回退: 沿回退链取第一个收录该曲的服出谱面图 */
async function sendChart(
    res: express.Response,
    servers: Server[],
    songId: number,
    difficultyId: number,
    compress: boolean,
    mirror: boolean,
    noteSpeed: number
): Promise<void> {
    const server = await firstServerHavingSong(songId, servers);
    if (!server) {
        res.send(listToBase64(['错误: 歌曲不存在']));
        return;
    }
    const result = await drawSongChart(server, songId, difficultyId, compress, mirror, noteSpeed);
    res.send(listToBase64(result));
}

export { router as songChartRouter };
