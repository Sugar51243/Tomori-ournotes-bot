import { loadImage, Image } from '@napi-rs/canvas';
import { Song } from '../../types/Song';
import { getChartManifest, getChartNotes, difficultyIdToName, DifficultyName } from '../../chart/client';
import { parseNnNotes, mirrorChart } from '../../chart/parse';
import { drawOurNotesPreview, ChartPreviewHeader, NOTE_SPEED_DEFAULT } from '../../components/OurNotesPreview';
import { getNoteSkin } from '../../data/noteSkin';
import { imageBuffer, jacketUrl } from '../../data/assets';
import { logger } from '../../logger';
import { Server, withServer } from '../../types/Server';

async function loadCover(server: Server, assetName: string): Promise<Image | undefined> {
    const buf = await imageBuffer(jacketUrl(server, assetName), `images/jacket/${server}/${assetName}.webp`);
    if (!buf) return undefined;
    try {
        return await loadImage(buf);
    } catch {
        return undefined;
    }
}

/**
 * 谱面预览图: songId + difficultyId(0-3) + mirror + compress -> PNG/JPEG Buffer
 */
export async function drawSongChart(server: Server, songId: number, difficultyId: number, compress: boolean, mirror: boolean, noteSpeed: number = NOTE_SPEED_DEFAULT): Promise<Array<Buffer | string>> {
    const song = withServer(new Song(songId), server);
    await song.init();
    if (!song.isExist) {
        return ['错误: 歌曲不存在'];
    }
    const difficultyName = difficultyIdToName(difficultyId);
    if (!difficultyName || !song.difficulty[difficultyId]) {
        return ['错误: 难度不存在'];
    }

    const diff = song.difficulty[difficultyId];
    const manifest = await getChartManifest(songId, difficultyName as DifficultyName);
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

    // 作者信息
    const author = [song.lyricist && `作词: ${song.lyricist}`, song.composer && `作曲: ${song.composer}`, song.arranger && `编曲: ${song.arranger}`]
        .filter(Boolean).join('\n');

    const header: ChartPreviewHeader = {
        id: songId,
        title: chart.title,
        artist: song.bandName,
        author,
        diff: difficultyName,
        level: chart.level,
        cover: song.row ? await loadCover(song.server, song.row.jacketAssetName) : undefined
    };

    // 官方音符皮肤素材(失败时渲染器自动退化为内置形状)
    const skin = await getNoteSkin(songId, difficultyName).catch(e => {
        logger('songChart', `note skin load failed, falling back to shapes: ${e instanceof Error ? e.message : e}`);
        return undefined;
    });

    const buffer = await drawOurNotesPreview(header, chart, compress, skin, noteSpeed);
    return [buffer];
}
