import express from 'express';
import { body } from 'express-validator';
import { isInteger, listToBase64, pickEntityInput } from '../utils';
import { fallbackChain, isServerInput, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { drawSongChart } from '../../view/song/songChart';
import { drawSongList } from '../../view/song/songList';
import { firstServerHavingSong } from '../../data/serverInfo';
import { findSongMatches } from './searchSong';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../../components/OurNotesPreview';

/**
 * 谱面图(单服回退)。
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`,
 * 传一个字段即可 —— 数字/纯数字字符串按 ID 直查, 其它文本走模糊搜索(唯一命中出谱面图, 多命中出歌曲列表图)。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 查询输入(任选其一或组合, 优先级见 utils.pickEntityInput)
        body('id').optional(),
        body('songId').optional(),
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
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(422).json({ status: 'failed', data: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' });
        }
        const options = {
            difficultyId: req.body.difficultyId ?? 3,
            compress: req.body.compress ?? false,
            mirror: req.body.mirror ?? false,
            noteSpeed: req.body.noteSpeed ?? req.body.speed ?? NOTE_SPEED_DEFAULT
        };

        try {
            const servers = fallbackChain(req.body);

            // 数字 ID(直接传或用数字文本) -> 直查
            if (typeof input === 'string' && isInteger(input)) {
                return sendChart(res, servers, { songId: parseInt(input, 10), ...options });
            }

            // 文字搜索: 沿回退链找候选(ID > 自信息 > 关联由 search 层保证)
            const hit = await findSongMatches(servers, input);
            if ('error' in hit) {
                return res.send(listToBase64([hit.error]));
            }
            // 多命中 -> 歌曲列表图; 唯一命中 -> 该曲谱面图
            if (hit.songs.length > 1) {
                const list = await drawSongList(hit.server, hit.songs, req.body.compress);
                return res.send(listToBase64(list));
            }
            return sendChart(res, servers, { songId: hit.songs[0].songId, ...options });
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

interface ChartQuery {
    songId: number;
    difficultyId: number;
    compress: boolean;
    mirror: boolean;
    noteSpeed: number;
}

/** 单服回退: 沿回退链取第一个收录该曲的服出谱面图 */
async function sendChart(res: express.Response, servers: Server[], query: ChartQuery): Promise<void> {
    const server = await firstServerHavingSong(query.songId, servers);
    if (!server) {
        res.send(listToBase64(['错误: 歌曲不存在']));
        return;
    }
    const result = await drawSongChart(server, query.songId, query.difficultyId, query.compress, query.mirror, query.noteSpeed);
    res.send(listToBase64(result));
}

export { router as songChartRouter };
