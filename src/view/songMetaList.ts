import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Server, serverProfile } from '../types/Server';
import { Song } from '../types/Song';
import { EfficiencyRow } from '../types/MusicData';
import { OVERHEAD_MS, DEFAULT_SKILL_PERCENT } from '../data/musicData/client';
import { imageBuffer, jacketUrl } from '../data/assets';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../components/list';
import { drawBackground } from '../components/background';
import { drawServerIcon } from '../components/serverIcon';
import { fillTextCentered, formatTime, cleanText } from '../components/draw';
import { cjkFontFamily } from '../components/fonts';

/**
 * 歌曲meta · 效率排行图(**一图两榜**):
 *   击奏live 与 自由live 各自效率(分/综合力/分钟)最高的前 15 张谱面。
 * 难度按需求**四难度混排**(EZ/NM/HD/EX 一起参与排行), 时长取 BGM 时长。
 *
 * 每行: 封面 + ID + 曲名 + 乐团 | 综合力/分钟 | 等级 | 难度 | 时长 | BPM | Notes | 出分(分/综合力)。
 * 算法与站点「歌曲meta」一致(期望分/综合力 ÷ (BGM 时长 + 结算耗时)), 见 data/musicData/client.ts。
 */

const WIDTH = 900;
const MARGIN = 12;
/**
 * 行高必须装得下「封面 + 两行文字」: 行底色只有 ROW_H - 4 高, 封面与 ID/乐团行一旦超出
 * 就会画到行框外面去(实测 32px 行 + 40px 封面时, 封面上下各溢出 6px、乐团行压到框底之下)。
 */
const ROW_H = 40;
const JACKET = 34;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const SECTION_TOP = 26 + 6;
const TABLE_HEAD_H = 22;
const SECTION_BOTTOM = 10;
const FOOTER_H = 20;

const DIFF_LABELS: Record<string, string> = { easy: 'EZ', normal: 'NM', hard: 'HD', expert: 'EX' };

/** 各列右边缘(从右往左定): 出分 / Notes / BPM / 时长 / 难度 / 等级 / 综合力分钟 */
const R_RATE = WIDTH - MARGIN;
const R_NOTES = R_RATE - 128;
const R_BPM = R_NOTES - 56;
const R_TIME = R_BPM - 56;
const R_DIFF = R_TIME - 48;
const R_LEVEL = R_DIFF - 46;
const R_PERMIN = R_LEVEL - 96;
/**
 * 左块右缘。**必须整列让开综合力/分钟列** —— 该列的值右对齐在 R_PERMIN,
 * 宽度取到 6 位小数(如 383.69)约 45px、表头「综合力/分钟」约 72px,
 * 只留 16px 的话长曲名(日文长标题)会被压到与数字重叠。
 */
const LEFT_END = R_PERMIN - 100;

function sectionHeight(rows: number): number {
    return SECTION_TOP + TABLE_HEAD_H + Math.max(rows, 1) * ROW_H + SECTION_BOTTOM;
}

/** 一行谱面(两榜共用同一套列) */
async function drawRow(ctx: SKRSContext2D, song: Song | undefined, row: EfficiencyRow, rank: number, y: number): Promise<void> {
    const x = MARGIN;
    ctx.fillStyle = rank <= 3 ? 'rgba(255,255,255,0.08)' : (rank % 2 ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.15)');
    ctx.fillRect(x, y, WIDTH - MARGIN * 2, ROW_H - 4);

    const midY = y + (ROW_H - 4) / 2;
    ctx.textBaseline = 'middle';

    // 封面(取不到保持占位块)
    const jx = x + 4;
    ctx.fillStyle = '#222';
    ctx.fillRect(jx, y + (ROW_H - 4 - JACKET) / 2, JACKET, JACKET);
    if (song?.row?.jacketAssetName) {
        const name = String(song.row.jacketAssetName);
        const cover = await imageBuffer(jacketUrl(song.server, name), `images/jacket/${song.server}/${name}.webp`);
        if (cover) {
            try { ctx.drawImage(await loadImage(cover), jx, y + (ROW_H - 4 - JACKET) / 2, JACKET, JACKET); } catch { /* 占位 */ }
        }
    }

    // 左块: 曲名 + ID/乐团
    const tx = x + 4 + JACKET + 8;
    ctx.textAlign = 'left';
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#FFF';
    ctx.fillText(cleanText(song?.musicTitle ?? `#${row.musicId}`), tx, y + 12, LEFT_END - tx - 4);
    // 这一行混着乐队名(可能是中文, 如「梦限大MewType」), 必须走 CJK 字体栈, 裸 Arial 会出豆腐块
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`ID ${row.musicId} · ${song?.bandName || '未知乐团'}`, tx, y + 27, LEFT_END - tx - 4);

    // 数值列(右对齐)
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px "Arial"';
    ctx.fillStyle = '#ffd76e';
    ctx.fillText(row.perMinute.toFixed(2), R_PERMIN, midY, 92);
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#FFF';
    ctx.fillText(String(row.displayLevel), R_LEVEL, midY, 42);
    ctx.fillText(DIFF_LABELS[row.difficulty] ?? row.difficulty, R_DIFF, midY, 44);
    ctx.fillText(formatTime(row.bgmMs), R_TIME, midY, 52);
    ctx.fillStyle = '#DDD';
    ctx.fillText(String(row.bpmMain), R_BPM, midY, 52);
    ctx.fillText(String(row.notes), R_NOTES, midY, 124);
    ctx.fillStyle = '#7ec8ff';
    ctx.fillText(row.rate.toFixed(2), R_RATE, midY, 124);
    ctx.textAlign = 'left';
}

async function drawBoard(ctx: SKRSContext2D, title: string, rows: EfficiencyRow[], songs: Map<number, Song>, y: number): Promise<number> {
    y = drawSectionBand(ctx, WIDTH, y, title, MARGIN);

    // 表头
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    // 每列都传 maxWidth(列的可用宽度): 右对齐 + maxWidth 会把标题压在**本列内**, 不会溢到隔壁列
    const cellW = (right: number, prevRight: number) => Math.max(24, right - prevRight - 6);
    ctx.fillText('曲目', MARGIN + 4, y + TABLE_HEAD_H / 2, LEFT_END - MARGIN - 4);
    ctx.textAlign = 'right';
    ctx.fillText('综合力/分钟', R_PERMIN, y + TABLE_HEAD_H / 2, cellW(R_PERMIN, LEFT_END));
    ctx.fillText('等级', R_LEVEL, y + TABLE_HEAD_H / 2, cellW(R_LEVEL, R_PERMIN));
    ctx.fillText('难度', R_DIFF, y + TABLE_HEAD_H / 2, cellW(R_DIFF, R_LEVEL));
    ctx.fillText('时长', R_TIME, y + TABLE_HEAD_H / 2, cellW(R_TIME, R_DIFF));
    ctx.fillText('BPM', R_BPM, y + TABLE_HEAD_H / 2, cellW(R_BPM, R_TIME));
    ctx.fillText('Notes', R_NOTES, y + TABLE_HEAD_H / 2, cellW(R_NOTES, R_BPM));
    ctx.fillText('出分', R_RATE, y + TABLE_HEAD_H / 2, cellW(R_RATE, R_NOTES));
    ctx.textAlign = 'left';
    y += TABLE_HEAD_H;

    for (let i = 0; i < rows.length; i++) {
        await drawRow(ctx, songs.get(rows[i].musicId), rows[i], i + 1, y);
        y += ROW_H;
    }
    return y + SECTION_BOTTOM;
}

export async function drawSongMetaList(
    server: Server,
    battle: EfficiencyRow[],
    free: EfficiencyRow[],
    songs: Map<number, Song>,
    compress: boolean
): Promise<Array<Buffer | string>> {
    const height = HEADER_H + MARGIN
        + sectionHeight(battle.length) + sectionHeight(free.length)
        + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, '歌曲meta · 效率排行');

    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `四难度混排 · 技能全 ${DEFAULT_SKILL_PERCENT}% · 结算耗时 ${OVERHEAD_MS / 1000}s`, hx, metaMidY, WIDTH - MARGIN - hx);

    let y = HEADER_H + MARGIN;
    y = await drawBoard(ctx, '击奏live 效率 Top 15', battle, songs, y);
    y = await drawBoard(ctx, '自由live 效率 Top 15', free, songs, y);

    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`效率 = 期望分/综合力 ÷ (BGM 时长 + ${OVERHEAD_MS / 1000}s 结算耗时)；出分 = 分/综合力；时长取 BGM 时长；数据与站点「歌曲meta」同源`,
        MARGIN, y + FOOTER_H / 2, WIDTH - MARGIN * 2);

    return [await outputFinalBuffer(canvas, compress)];
}
