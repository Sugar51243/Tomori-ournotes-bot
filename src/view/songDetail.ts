import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Song } from '../types/Song';
import { formatGameDateUTC8 } from '../types/Gacha';
import { imageBuffer, jacketUrl } from '../data/assets';
import { drawTitle, drawDatablock, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { diffColorList } from '../components/OurNotesPreview';
import { cardTypeColors } from '../types/Card';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';

/**
 * 歌曲详情信息图: 尽量展开全部信息 ——
 * 封面、ID、标题(含假名/罗马音)、乐队、分类、演唱角色、上架时间、时长、BPM、应援色、
 * 四难度等级与音符数、词曲编。
 */
const WIDTH = 720;
const MARGIN = 16;
const JACKET_X = 16, JACKET_Y = 64, JACKET_SIZE = 250;
const INFO_X = 290;
const CJK = FONT_STACK;

/** 应援色色块 + 主色值 */
function drawPenLight(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, x: number, y: number, colors: string[]): void {
    let cx = x;
    for (const color of colors) {
        ctx.fillStyle = color;
        ctx.fillRect(cx, y + 2, 20, 16);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, y + 2.5, 19, 15);
        cx += 24;
    }
    ctx.fillStyle = '#BBB';
    ctx.font = '13px "Arial"';
    ctx.fillText(colors[0] ?? '-', cx + 4, y + 5, 90);
}

/**
 * 内容排版(不含封面图片本体): 封面占位/ID 角标 → 右侧信息 → 难度明细 → 创作信息。
 * 返回内容结束 y, 供画布高度与绘制共用(同一段代码先跑在测量画布上即为预排版)。
 */
function renderContent(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, song: Song): number {
    // ---- 封面占位 ----
    ctx.fillStyle = '#222';
    ctx.fillRect(JACKET_X, JACKET_Y, JACKET_SIZE, JACKET_SIZE);

    // ---- 右侧信息 ----
    let y = JACKET_Y;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#FFF';
    ctx.font = `26px ${CJK}`;
    for (const line of wrapTextLines(ctx, song.musicTitle, WIDTH - INFO_X - 16, 2)) {
        ctx.fillText(line, INFO_X, y, WIDTH - INFO_X - 16);
        y += 34;
    }
    // 假名/罗马音(可能为 CJK 文本, 需用 CJK 字体栈)
    if (song.phoneticTitle) {
        ctx.fillStyle = '#9aa4b2';
        ctx.font = `15px ${CJK}`;
        ctx.fillText(song.phoneticTitle, INFO_X, y, WIDTH - INFO_X - 16);
        y += 24;
    }
    y += 6;

    const infoRows: [string, string][] = [];
    infoRows.push(['乐队', song.bandName || '-']);
    if (song.categories.length) infoRows.push(['分类', song.categories.join(' / ')]);
    if (song.vocalNames.length) infoRows.push(['演唱', song.vocalNames.join('、')]);
    infoRows.push(['上架时间', formatGameDateUTC8(song.startAt)]);
    if (song.durationMs) {
        const totalSec = Math.round(song.durationMs / 1000);
        infoRows.push(['时长', `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`]);
    }
    if (song.bpmText) infoRows.push(['BPM', song.bpmText]);
    y = drawDatablock(ctx, INFO_X, y, infoRows.map(([key, text]) => ({ key, text })), WIDTH - INFO_X - 16, { fontSize: 15 });
    // 属性: 值用与卡片同款的色块(乐曲属性 红/蓝/绿/黄/紫, 与卡片 cardType 同一套)
    if (song.attribute) {
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9aa4b2';
        ctx.font = `15px ${CJK}`;
        ctx.fillText('属性', INFO_X, y);
        ctx.fillStyle = cardTypeColors[song.musicType] ?? '#888';
        ctx.fillRect(INFO_X + 76, y + 2, 52, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = `13px ${CJK}`;
        ctx.fillText(song.attribute, INFO_X + 82, y + 6, 44);
        y += 25;
    }
    // 应援色
    if (song.penLightColors.length) {
        ctx.fillStyle = '#9aa4b2';
        ctx.font = `15px ${CJK}`;
        ctx.textBaseline = 'top';
        ctx.fillText('应援色', INFO_X, y);
        drawPenLight(ctx, INFO_X + 76, y, song.penLightColors);
    }

    // ---- 难度明细 ----
    const diffY = JACKET_Y + JACKET_SIZE + 26;
    ctx.fillStyle = '#3a5fa8';
    ctx.fillRect(JACKET_X, diffY, 4, 20);
    ctx.fillStyle = '#FFF';
    ctx.font = `bold 17px ${CJK}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('难度', JACKET_X + 14, diffY + 10);

    const diffNames = ['EZ', 'NM', 'HD', 'EX'];
    const diffKeys = ['easy', 'normal', 'hard', 'expert'];
    let dx = JACKET_X + 70;
    const chipY = diffY - 2;
    for (let i = 0; i < 4; i++) {
        const d = song.difficulty[i];
        if (!d || !d.playLevel) continue;
        const label = `${diffNames[i]} ${d.displayLevel}  (${d.fullComboCount})`;
        ctx.font = '15px "Arial"';
        const w = ctx.measureText(label).width + 16;
        ctx.fillStyle = diffColorList[diffKeys[i]] ?? '#888';
        ctx.fillRect(dx, chipY, w, 24);
        ctx.fillStyle = '#FFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, dx + 8, chipY + 12, w - 16);
        dx += w + 10;
    }

    // ---- 创作信息 ----
    ctx.textBaseline = 'top';
    return drawDatablock(ctx, JACKET_X, diffY + 44, [
        { key: '作词', text: song.lyricist || '-' },
        { key: '作曲', text: song.composer || '-' },
        { key: '编曲', text: song.arranger || '-' }
    ], WIDTH - 32, { fontSize: 14 });
}

export async function drawSongDetail(song: Song, compress: boolean): Promise<Array<Buffer | string>> {
    // 详情需要时长/BPM(需谱面 bundle), 按需加载
    await song.loadChartInfo();

    // 先量后画: 同一段排版先跑在测量画布上, 取得内容高度后建正式画布(避免底部大片空白)
    const contentEnd = renderContent(createCanvas(10, 10).getContext('2d'), song);
    const HEIGHT = Math.max(contentEnd, JACKET_Y + JACKET_SIZE) + MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, HEIGHT, song.bandId);
    drawTitle(ctx, WIDTH, '歌曲详情');

    renderContent(ctx, song);

    // 封面图片 + ID 角标(位置固定, 不影响排版; 角标须画在封面之上)
    if (song.row) {
        const cover = await imageBuffer(jacketUrl(song.row.jacketAssetName), `images/jacket/${song.row.jacketAssetName}.webp`);
        if (cover) {
            try {
                ctx.drawImage(await loadImage(cover), JACKET_X, JACKET_Y, JACKET_SIZE, JACKET_SIZE);
            } catch { /* 占位 */ }
        }
    }
    ctx.fillStyle = '#1f1e33';
    ctx.fillRect(JACKET_X, JACKET_Y, 128, 24);
    ctx.fillStyle = '#FFF';
    ctx.font = '16px "Arial"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(song.songId), JACKET_X + 64, JACKET_Y + 12, 128);

    return [await outputFinalBuffer(canvas, compress)];
}
