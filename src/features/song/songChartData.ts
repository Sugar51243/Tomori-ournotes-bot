import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { Song } from '../types/Song';
import { Server, withServer } from '../types/Server';
import { firstServerHavingSong } from '../../db/adapter';
import { getChartManifest, getChartNotes, difficultyIdToName } from '../../upstream/adapter';
import { parseNnNotes, mirrorChart } from '../chart/parse';
import { simplifyChart } from '../chart/simplify';
import { findSongMatches } from './searchSong';

/**
 * 谱面数据(纯 JSON, 不 base64)的功能实现:
 * POST { id | songId | text | fuzzySearchResult, difficultyId(0-3), mirror?, format?: 'raw'|'simple'|'both' }
 * -> { status:'success', data:{ meta, raw?, simple? } }
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput), 传一个字段即可:
 * 数字/纯数字字符串按 ID 直查; 其它文本走模糊搜索(唯一命中即取该曲)。
 */

export type ChartDataTarget =
    | { ok: true; server: Server; songId: number }
    | { ok: false; message: string };

/** 解析成歌曲 ID + 收录服: 数字直用; 文本走模糊搜索(唯一命中才取) */
export async function resolveSongChartTarget(servers: Server[], input: EntityInput): Promise<ChartDataTarget> {
    let songId: number;
    if (typeof input === 'string' && isInteger(input)) {
        songId = parseInt(input, 10);
    } else {
        const hit = await findSongMatches(servers, input);
        if ('error' in hit) {
            return { ok: false, message: hit.error };
        }
        if (hit.songs.length > 1) {
            const names = hit.songs.slice(0, 5).map(s => `${s.songId} ${s.musicTitle}`).join(' / ');
            return { ok: false, message: `错误: 匹配到多首歌曲, 请用 songId 精确指定: ${names}` };
        }
        songId = hit.songs[0].songId;
    }

    // 单服回退: 沿回退链取第一个收录该曲的服
    const server = await firstServerHavingSong(songId, servers);
    if (!server) {
        return { ok: false, message: '错误: 歌曲不存在' };
    }
    return { ok: true, server, songId };
}

export interface ChartDataQuery {
    songId: number;
    difficultyId: number;
    mirror: boolean;
    format: string;
}

/**
 * 谱面数据入口: 拉清单与谱面文件, 解析成 { meta, raw?, simple? } JSON(不 base64)。
 * @param server 单服(调用方已按回退链选定)
 * @param query songId / difficultyId / mirror / format
 */
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
