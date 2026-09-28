import { createCanvas } from '@napi-rs/canvas';
import { Song } from '../types/Song';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { diffColorList } from '../components/OurNotesPreview';
import { FONT_STACK } from '../components/fonts';

const WIDTH = 900;
const ROW_H = 26;
const HEADER_H = 48;

/** 全歌曲 meta 表(tsugu songMeta 对应物) */
export async function drawSongMetaList(songs: Song[], compress: boolean): Promise<Array<Buffer | string>> {
    const height = HEADER_H + 16 + songs.length * ROW_H + 16;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    // 全歌曲列表跨多个乐队, 使用 other 背景
    await drawBackground(ctx, WIDTH, height);
    drawTitle(ctx, WIDTH, `全歌曲列表 (${songs.length})`);

    // 表头
    const cols = [
        { x: 8, w: 62, label: 'ID' },
        { x: 70, w: 256, label: '标题' },
        { x: 326, w: 118, label: '乐队' },
        { x: 444, w: 78, label: '分类' },
        { x: 522, w: 52, label: 'EZ' },
        { x: 574, w: 52, label: 'NM' },
        { x: 626, w: 52, label: 'HD' },
        { x: 678, w: 52, label: 'EX' },
        { x: 730, w: 78, label: '音符(EX)' },
        { x: 808, w: 84, label: '时长' }
    ];
    ctx.fillStyle = 'rgba(24, 26, 44, 0.82)';
    ctx.fillRect(0, HEADER_H, WIDTH, ROW_H);
    ctx.fillStyle = '#FFF';
    // 表头含中文(标题/乐队), 需 CJK 字体栈
    ctx.font = `14px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const c of cols) ctx.fillText(c.label, c.x + 4, HEADER_H + ROW_H / 2, c.w - 8);

    const diffKeys = ['easy', 'normal', 'hard', 'expert'];
    songs.forEach((song, i) => {
        const y = HEADER_H + ROW_H + i * ROW_H;
        if (i % 2 === 1) {
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(0, y, WIDTH, ROW_H);
        }
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#BBB';
        ctx.font = '13px "Arial"';
        ctx.fillText(String(song.songId), cols[0].x + 4, y + ROW_H / 2, cols[0].w - 8);
        ctx.fillStyle = '#FFF';
        ctx.font = `14px ${FONT_STACK}`;
        ctx.fillText(song.musicTitle, cols[1].x + 4, y + ROW_H / 2, cols[1].w - 8);
        ctx.fillStyle = '#BBB';
        ctx.font = `13px ${FONT_STACK}`;
        ctx.fillText(song.bandName, cols[2].x + 4, y + ROW_H / 2, cols[2].w - 8);
        // 分类
        ctx.fillStyle = '#9aa4b2';
        ctx.font = `13px ${FONT_STACK}`;
        ctx.fillText(song.categories.join('/'), cols[3].x + 4, y + ROW_H / 2, cols[3].w - 8);
        for (let d = 0; d < 4; d++) {
            const diff = song.difficulty[d];
            if (!diff || !diff.playLevel) continue;
            ctx.fillStyle = diffColorList[diffKeys[d]] ?? '#888';
            ctx.font = '13px "Arial"';
            ctx.fillText(`${diff.displayLevel}`, cols[4 + d].x + 4, y + ROW_H / 2, cols[4 + d].w - 8);
        }
        // EX 音符数与时长
        const ex = song.difficulty[3];
        ctx.fillStyle = '#BBB';
        ctx.font = '12px "Arial"';
        ctx.fillText(ex?.fullComboCount ? String(ex.fullComboCount) : '-', cols[8].x + 4, y + ROW_H / 2, cols[8].w - 8);
        const duration = song.durationMs ? `${Math.floor(song.durationMs / 60000)}:${String(Math.round(song.durationMs / 1000) % 60).padStart(2, '0')}` : '-';
        ctx.fillText(duration, cols[9].x + 4, y + ROW_H / 2, cols[9].w - 8);
    });

    return [await outputFinalBuffer(canvas, compress)];
}
