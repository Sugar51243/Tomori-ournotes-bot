import express from 'express';
import { body } from 'express-validator';
import { middleware } from '../middleware';
import { Song } from '../../types/Song';
import { fallbackChain, isServerInput, Server, withServer } from '../../types/Server';
import { firstServerHavingSong } from '../../data/serverInfo';
import { getChartManifest, getChartNotes, difficultyIdToName } from '../../chart/client';
import { parseNnNotes, mirrorChart } from '../../chart/parse';
import { simplifyChart } from '../../chart/simplify';

/**
 * 谱面数据端点(纯 JSON, 不 base64):
 * POST { songId, difficultyId(0-3), mirror?, format?: 'raw'|'simple'|'both' }
 * -> { status:'success', data:{ meta, raw?, simple? } }
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('songId').isInt(),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('mirror').optional().isBoolean(),
        body('format').optional().isIn(['raw', 'simple', 'both']),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { songId, difficultyId = 3, mirror = false, format = 'simple' } = req.body;
        try {
            // 单服回退: 沿回退链取第一个收录该曲的服
            const server = await firstServerHavingSong(songId, fallbackChain(req.body));
            if (!server) {
                return res.send({ status: 'failed', data: '错误: 歌曲不存在' });
            }
            const result = await commandSongChartData(server, songId, difficultyId, mirror, format);
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

export async function commandSongChartData(server: Server, songId: number, difficultyId: number, mirror: boolean, format: string) {
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
