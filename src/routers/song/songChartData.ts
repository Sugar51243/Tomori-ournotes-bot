import express from 'express';
import { body } from 'express-validator';
import { isInteger, pickEntityInput } from '../utils';
import { middleware } from '../middleware';
import { Song } from '../../types/Song';
import { fallbackChain, isServerInput, Server, withServer } from '../../types/Server';
import { firstServerHavingSong } from '../../data/serverInfo';
import { isFuzzySearchResult } from '../../fuzzySearch';
import { getChartManifest, getChartNotes, difficultyIdToName } from '../../chart/client';
import { parseNnNotes, mirrorChart } from '../../chart/parse';
import { simplifyChart } from '../../chart/simplify';
import { findSongMatches } from './searchSong';

/**
 * 谱面数据端点(纯 JSON, 不 base64):
 * POST { id | songId | text | fuzzySearchResult, difficultyId(0-3), mirror?, format?: 'raw'|'simple'|'both' }
 * -> { status:'success', data:{ meta, raw?, simple? } }
 *
 * 查询输入按统一规则解析(见 utils.pickEntityInput), 传一个字段即可:
 * 数字/纯数字字符串按 ID 直查; 其它文本走模糊搜索(唯一命中即取该曲)。
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
        body('mirror').optional().isBoolean(),
        body('format').optional().isIn(['raw', 'simple', 'both']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const input = pickEntityInput(req.body, ['songId']);
        if (input === undefined) {
            return res.status(400).send({ status: 'failed', data: '参数错误', error: [{ msg: '需要提供查询输入: id / songId / text / fuzzySearchResult 之一' }] });
        }
        try {
            const servers = fallbackChain(req.body);

            // 解析成歌曲 ID: 数字直用; 文本走模糊搜索(唯一命中才取)
            let songId: number;
            if (typeof input === 'string' && isInteger(input)) {
                songId = parseInt(input, 10);
            } else {
                const hit = await findSongMatches(servers, input);
                if ('error' in hit) {
                    return res.send({ status: 'failed', data: hit.error });
                }
                if (hit.songs.length > 1) {
                    const names = hit.songs.slice(0, 5).map(s => `${s.songId} ${s.musicTitle}`).join(' / ');
                    return res.send({ status: 'failed', data: `错误: 匹配到多首歌曲, 请用 songId 精确指定: ${names}` });
                }
                songId = hit.songs[0].songId;
            }

            // 单服回退: 沿回退链取第一个收录该曲的服
            const server = await firstServerHavingSong(songId, servers);
            if (!server) {
                return res.send({ status: 'failed', data: '错误: 歌曲不存在' });
            }
            const result = await commandSongChartData(server, {
                songId,
                difficultyId: req.body.difficultyId ?? 3,
                mirror: req.body.mirror ?? false,
                format: req.body.format ?? 'simple'
            });
            res.send({ status: 'success', data: result });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (message.startsWith('错误')) {
                res.send({ status: 'failed', data: message });
            } else {
                console.log(e);
                res.status(500).send({ status: 'failed', data: '内部错误' });
            }
        }
    }
);

export interface ChartDataQuery {
    songId: number;
    difficultyId: number;
    mirror: boolean;
    format: string;
}

export async function commandSongChartData(server: Server, query: ChartDataQuery) {
    const { songId, difficultyId, mirror, format } = query;
    const song = withServer(new Song(songId), server);
    await song.init();
    if (!song.isExist) {
        throw new Error('错误: 歌曲不存在');
    }
    const difficultyName = difficultyIdToName(difficultyId);
    if (!difficultyName || !song.difficulty[difficultyId]) {
        throw new Error('错误: 难度不存在');
    }
    const diff = song.difficulty[difficultyId];

    const manifest = await getChartManifest(songId, difficultyName);
    const raw = await getChartNotes(songId, difficultyId);

    let chart = parseNnNotes(raw, {
        musicId: songId,
        difficulty: difficultyId,
        title: song.musicTitle || manifest.chart.title,
        level: diff.playLevel || manifest.chart.level,
        durationMs: manifest.chart.durationMs,
        fullComboCount: manifest.chart.fullComboCount
    });
    if (mirror) {
        chart = mirrorChart(chart);
    }

    const meta = {
        musicId: songId,
        difficulty: difficultyName,
        level: chart.level,
        title: chart.title,
        durationMs: chart.durationMs,
        laneCount: chart.laneCount,
        counts: chart.counts,
        bpm: chart.bpm,
        feverCount: chart.fever.length,
        slideCount: chart.slides.length
    };

    const out: Record<string, unknown> = { meta };
    if (format === 'raw' || format === 'both') {
        out.raw = raw;
    }
    if (format === 'simple' || format === 'both') {
        out.simple = simplifyChart(chart);
    }
    return out;
}

export { router as songChartDataRouter };
