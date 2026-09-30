import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Song } from '../types/Song';
import { imageBuffer, jacketUrl } from '../data/assets';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground, commonBandId } from '../components/background';
import { diffColorList } from '../components/OurNotesPreview';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';
import { Server } from '../types/Server';

const COL_COUNT = 2;
const CARD_W = 460;
const CARD_H = 110;
const MARGIN = 16;

/** 歌曲搜索列表图(2 列卡片网格) */
export async function drawSongList(server: Server, songs: Song[], compress: boolean): Promise<Array<Buffer | string>> {
    const rows = Math.ceil(songs.length / COL_COUNT);
    const width = MARGIN + COL_COUNT * (CARD_W + MARGIN);
    const height = 56 + rows * (CARD_H + MARGIN) + MARGIN;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 结果全部同属一个乐队时用该乐队背景, 混合结果用 other 背景
    await drawBackground(ctx, width, height, { server, bandId: commonBandId(songs.map(s => s.bandId)) });
    drawTitle(ctx, width, `共 ${songs.length} 首歌曲`);

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        const col = i % COL_COUNT;
        const row = Math.floor(i / COL_COUNT);
        const x = MARGIN + col * (CARD_W + MARGIN);
        const y = 56 + row * (CARD_H + MARGIN);

        // 卡片底
        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(x, y, CARD_W, CARD_H);
        // 封面
        ctx.fillStyle = '#222';
        ctx.fillRect(x + 8, y + 8, 94, 94);
        if (song.row) {
            const cover = await imageBuffer(jacketUrl(song.server, song.row.jacketAssetName), `images/jacket/${song.server}/${song.row.jacketAssetName}.webp`);
            if (cover) {
                try {
                    ctx.drawImage(await loadImage(cover), x + 8, y + 8, 94, 94);
                } catch { /* 占位 */ }
            }
        }
        // id
        ctx.fillStyle = '#1f1e33';
        ctx.fillRect(x + 8, y + 8, 64, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = '14px "Arial"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(song.songId), x + 40, y + 18, 64);

        // 标题 + 乐队
        const tx = x + 116;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#FFF';
        ctx.font = `18px ${FONT_STACK}`;
        const titleLines = wrapTextLines(ctx, song.musicTitle, CARD_W - 124, 2);
        let ty = y + 12;
        for (const line of titleLines) {
            ctx.fillText(line, tx, ty, CARD_W - 124);
            ty += 24;
        }
        ctx.font = `14px ${FONT_STACK}`;
        ctx.fillStyle = '#BBB';
        ctx.fillText(song.bandName, tx, ty + 2, CARD_W - 124);

        // 难度徽章
        const diffNames = ['EZ', 'NM', 'HD', 'EX'];
        const diffKeys = ['easy', 'normal', 'hard', 'expert'];
        let bx = tx;
        const by = y + CARD_H - 30;
        for (let d = 0; d < 4; d++) {
            const diff = song.difficulty[d];
            if (!diff || !diff.playLevel) continue;
            const label = `${diffNames[d]} ${diff.displayLevel}`;
            ctx.font = '13px "Arial"';
            const w = ctx.measureText(label).width + 12;
            ctx.fillStyle = diffColorList[diffKeys[d]] ?? '#888';
            ctx.fillRect(bx, by, w, 20);
            ctx.fillStyle = '#FFF';
            ctx.fillText(label, bx + 6, by + 4, w - 12);
            bx += w + 6;
            if (bx > x + CARD_W - 60) break;
        }
    }

    return [await outputFinalBuffer(canvas, compress)];
}
