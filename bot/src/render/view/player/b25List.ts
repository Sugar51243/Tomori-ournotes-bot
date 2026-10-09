import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { jacketUrl, imageBuffer } from '../../../upstream/adapter';
import { Server, serverProfile } from '../../../features/types/Server';
import { Song } from '../../../features/types/Song';
import { formatScore } from '../../../features/types/Ranking';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { cjkFontFamily } from '../../component/fonts';
import { fillTextCentered, cleanText } from '../../component/draw';

/**
 * B25（BEST 25）单图: 25 行紧凑表 —— 名次 / 封面+曲名 / 难度 / 等级 / 计入值 / 分数。
 * 计入值口径与网页一致: AP 记谱面等级、FC 记等级-1（页脚注明）。
 */

const WIDTH = 820;
const MARGIN = 12;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const TABLE_HEAD_H = 20;
const ROW_H = 26;
const FOOTER_H = 34;
const JACKET = 20;

const DIFF_LABELS = ['EZ', 'NM', 'HD', 'EX'];

export interface B25Row {
    musicId: number;
    /** 0..3 = EZ/NM/HD/EX */
    difficulty: number;
    /** 计入值（AP = 等级, FC = 等级-1） */
    counted: number;
    /** 谱面显示等级（导入时按当时的服算） */
    level: number;
    score: number;
    song?: Song;
}

export interface B25View {
    playerId: string;
    /** 展示名（账号包备注/玩家名） */
    title: string;
    totalRating: number;
    /** 有记录的歌数（账号包 stats；未公开时没有） */
    totalSongs?: number;
    rows: B25Row[];
}

const COL_TITLE_X = MARGIN + 30 + JACKET + 8;
const COL_TITLE_W = 330;
const COL_DIFF = MARGIN + 30 + JACKET + 8 + COL_TITLE_W + 12;
const COL_LEVEL = COL_DIFF + 46;
const COL_COUNTED = COL_LEVEL + 56;
const COL_SCORE_RIGHT = WIDTH - MARGIN;

async function drawRow(ctx: SKRSContext2D, row: B25Row, rank: number, y: number): Promise<void> {
    ctx.fillStyle = rank <= 3 ? 'rgba(255,255,255,0.10)' : (rank % 2 ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.15)');
    ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 3);

    const midY = y + (ROW_H - 3) / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // 名次
    ctx.font = 'bold 13px "Arial"';
    ctx.fillStyle = rank <= 3 ? ['#ffd76e', '#cfd8e3', '#e0a06a'][rank - 1] : '#BBB';
    ctx.fillText(String(rank), MARGIN + 6, midY, 26);

    // 封面(取不到留占位块)
    const jx = MARGIN + 30;
    const jy = y + (ROW_H - 3 - JACKET) / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(jx, jy, JACKET, JACKET);
    const name = row.song?.row?.jacketAssetName ? String(row.song.row.jacketAssetName) : '';
    if (name) {
        const server = row.song?.server ?? 'tw';
        const buf = await imageBuffer(jacketUrl(server, name), `images/jacket/${server}/${name}.webp`).catch(() => undefined);
        if (buf) {
            try { ctx.drawImage(await loadImage(buf), jx, jy, JACKET, JACKET); } catch { /* 占位 */ }
        }
    }

    // 曲名
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    ctx.fillText(cleanText(row.song?.musicTitle ?? `#${row.musicId}`), COL_TITLE_X, midY, COL_TITLE_W);

    // 难度 / 等级 / 计入值 / 分数
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(DIFF_LABELS[row.difficulty] ?? String(row.difficulty), COL_DIFF, midY, 40);
    ctx.fillStyle = '#DDD';
    ctx.fillText(String(row.level), COL_LEVEL, midY, 48);
    ctx.font = 'bold 13px "Arial"';
    ctx.fillStyle = '#7ec8ff';
    ctx.fillText(String(row.counted), COL_COUNTED, midY, 60);
    ctx.fillStyle = '#ffd76e';
    ctx.textAlign = 'right';
    ctx.fillText(formatScore(row.score), COL_SCORE_RIGHT, midY, 120);
    ctx.textAlign = 'left';
}

export async function drawB25List(server: Server, view: B25View, compress: boolean): Promise<Buffer> {
    const height = HEADER_H + MARGIN + TABLE_HEAD_H + view.rows.length * ROW_H + FOOTER_H + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, 'B25 · BEST 25 计分榜');

    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 140);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 12;
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `ID ${view.playerId}`, hx, metaMidY, 100);
    hx += 106;
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, view.title, hx, metaMidY, WIDTH - MARGIN - 220 - hx);
    ctx.textAlign = 'right';
    // 带中文的单元格必须走 CJK 字体栈(裸 Arial 会出豆腐块)
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#ffd76e';
    fillTextCentered(ctx, `总计值 ${formatScore(view.totalRating)}`, WIDTH - MARGIN, metaMidY, 200);
    ctx.textAlign = 'left';

    let y = HEADER_H + MARGIN;

    // 表头
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textBaseline = 'middle';
    ctx.fillText('名次', MARGIN + 6, y + TABLE_HEAD_H / 2, 26);
    ctx.fillText('曲目', COL_TITLE_X, y + TABLE_HEAD_H / 2, COL_TITLE_W);
    ctx.fillText('难度', COL_DIFF, y + TABLE_HEAD_H / 2, 40);
    ctx.fillText('等级', COL_LEVEL, y + TABLE_HEAD_H / 2, 48);
    ctx.fillText('计入值', COL_COUNTED, y + TABLE_HEAD_H / 2, 60);
    ctx.textAlign = 'right';
    ctx.fillText('分数', COL_SCORE_RIGHT, y + TABLE_HEAD_H / 2, 120);
    ctx.textAlign = 'left';
    y += TABLE_HEAD_H;

    for (const [i, row] of view.rows.entries()) {
        await drawRow(ctx, row, i + 1, y);
        y += ROW_H;
    }

    // 页脚: 口径 + 数据来源
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#8a93a0';
    const songText = view.totalSongs !== undefined ? ` · 有记录 ${view.totalSongs} 首` : '';
    ctx.fillText(
        `计入值 = AP 记谱面等级 / FC 记等级-1（取全账号最高的 25 张谱面）；谱面等级为导入时按当时服务器解析${songText}`,
        MARGIN, y + 9, WIDTH - MARGIN * 2);
    ctx.fillText('数据来源：网页账号包（玩家自行导入的快照，非实时）', MARGIN, y + 24, WIDTH - MARGIN * 2);

    return outputFinalBuffer(canvas, compress);
}
