import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas';
import { Event } from '../../types/Event';
import { Server, serverProfile } from '../../types/Server';
import { Song } from '../../types/Song';
import { CutoffSeries } from '../../types/Cutoff';
import { cutoffPersistent } from '../../data/cutoff/store';
import { imageBuffer, jacketUrl } from '../../data/assets';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../components/list';
import { drawBackground } from '../../components/background';
import { drawServerIcon } from '../../components/serverIcon';
import { fillTextCentered, formatDateTime, cleanText, roundedRectPath } from '../../components/draw';
import { cjkFontFamily } from '../../components/fonts';

/**
 * 活动榜线 · 折线图(**一张图四格**: 每曲一格 + 三曲同格)。
 *
 * 横轴**铺满整个活动时长**(开启 → 结束), 纵轴是分数; 每条线 = 某曲的某一档(前 10 / 前 100 …),
 * 同一条线在四格里用同一个颜色, 方便对照。
 *
 * 数据是本地按小时采样的历史(上游没有历史接口): 没启用数据库时只在内存里, 重启会遗忘, 页脚会标注。
 */

const WIDTH = 980;
const MARGIN = 16;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
/** 单格图表区高度(不含标题与图例) */
const PANEL_PLOT_H = 210;
const PANEL_GAP = 14;
const PANEL_COLUMNS = 2;
const PANEL_W = (WIDTH - MARGIN * (PANEL_COLUMNS + 1)) / PANEL_COLUMNS;
/** 单格总高 = 标题 20 + 绘图区 + 图例 16 */
/** 单格头部(封面 22 + 间距): 绘图区从这里往下, 免得封面/标题压到坐标轴上 */
const PANEL_HEADER_H = 26;
/** 单格总高 = 头部 + 绘图区 + 图例 */
const PANEL_H = PANEL_HEADER_H + PANEL_PLOT_H + 24;
/** 采样点之间的间隔超过这个倍数的记录间隔就断开(表示那段没采到) */
const GAP_FACTOR = 3;
const GAP_MS = 3600_000 * GAP_FACTOR;

/** 线的配色: 每曲一色系, 档位用深浅区分(同一条线在四格里颜色一致) */
const SONG_COLORS = ['#7ec8ff', '#ffd76e', '#8fd0a0', '#ff9bb0', '#c9a6ff'];
const TIER_ALPHA = [1, 0.55, 0.35, 0.25, 0.2];

function colorOf(songIndex: number, tierIndex: number): string {
    const base = SONG_COLORS[songIndex % SONG_COLORS.length];
    const alpha = TIER_ALPHA[Math.min(tierIndex, TIER_ALPHA.length - 1)];
    if (alpha >= 1) return base;
    // 用 hex + alpha 通道让同曲不同档深浅可辨
    return base + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function fmtScore(n: number): string {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}万`;
    return String(Math.round(n));
}

/** 纵轴上界: 取最大值的 1.1 倍, 并向上取整到「好看」的刻度 */
function niceMax(max: number): number {
    if (!(max > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (max <= step * pow) return step * pow;
    }
    return 10 * pow;
}

interface Panel {
    title: string;
    /** 曲目封面(三曲同图那格没有); 解码好的 Image, 绘制阶段不能再 await */
    jacket?: Image;
    series: Array<{ series: CutoffSeries; color: string; label: string }>;
}

/** 画一格: 标题(带封面/ID) + 坐标轴 + 折线 + 图例 */
function drawPanel(
    ctx: SKRSContext2D,
    panel: Panel,
    x: number,
    y: number,
    startMs: number,
    span: number,
    yMax: number
): void {
    const plotX = x + 58;
    const plotY = y + PANEL_HEADER_H;
    const plotW = PANEL_W - 58 - 8;
    const plotH = PANEL_PLOT_H - 26;
    const xOf = (at: number) => plotX + Math.min(1, Math.max(0, (at - startMs) / span)) * plotW;
    const yOf = (score: number) => plotY + plotH - Math.min(1, Math.max(0, score / yMax)) * plotH;

    // 纯色打底: 折线要压在背景图上看, 不给底会看不清
    ctx.fillStyle = 'rgba(12, 14, 24, 0.82)';
    roundedRectPath(ctx, x, y, PANEL_W, PANEL_H, 6);
    ctx.fill();

    // 标题: 有封面就画一个 22x22 的小图(等比, 不拉伸), 再接曲名
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let titleX = x;
    if (panel.jacket) {
        const img = panel.jacket;
        ctx.fillStyle = '#222';
        ctx.fillRect(x, y + 1, 22, 22);
        const scale = Math.min(22 / img.width, 22 / img.height);
        ctx.drawImage(img, x + (22 - img.width * scale) / 2, y + 1 + (22 - img.height * scale) / 2, img.width * scale, img.height * scale);
        titleX = x + 28;
    }
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    ctx.fillText(panel.title, titleX, y + 2, x + PANEL_W - titleX);

    // 纵轴刻度 + 横网格
    ctx.font = cjkFontFamily(10);
    ctx.fillStyle = '#9aa4b2';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    const Y_TICKS = 3;
    for (let i = 0; i <= Y_TICKS; i++) {
        const v = (yMax / Y_TICKS) * i;
        const gy = yOf(v);
        ctx.beginPath();
        ctx.moveTo(plotX, gy + 0.5);
        ctx.lineTo(plotX + plotW, gy + 0.5);
        ctx.stroke();
        ctx.fillText(fmtScore(v), plotX - 6, gy, 50);
    }
    // 横轴: 起 / 中 / 止(整幅图预留整个活动时长)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of [0, 0.5, 1]) {
        const t = startMs + span * f;
        const d = new Date(t);
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, xOf(t), plotY + plotH + 4, 54);
    }

    // 折线(断档不连)
    for (const line of panel.series) {
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        let prevAt = 0;
        for (const p of line.series.points) {
            const px = xOf(p.at);
            const py = yOf(p.score);
            if (!started || p.at - prevAt > GAP_MS) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
            started = true;
            prevAt = p.at;
        }
        ctx.stroke();
        ctx.fillStyle = line.color;
        for (const p of line.series.points) {
            ctx.beginPath();
            ctx.arc(xOf(p.at), yOf(p.score), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // 图例(一行, 放不下就截断)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = cjkFontFamily(11);
    let lx = plotX;
    const ly = y + PANEL_H - 8;
    for (const line of panel.series) {
        const w = ctx.measureText(line.label).width + 26;
        if (lx + w > x + PANEL_W) break;
        ctx.fillStyle = line.color;
        ctx.fillRect(lx, ly - 4, 12, 8);
        ctx.fillStyle = '#DDD';
        ctx.fillText(line.label, lx + 16, ly, w - 20);
        lx += w;
    }
}

export async function drawCutoffChart(
    server: Server,
    event: Event,
    series: CutoffSeries[],
    songs: Map<number, Song>,
    compress: boolean,
    notes: string[] = []
): Promise<Array<Buffer | string>> {
    // 每曲一格 + 最后一格三曲同图
    const musicIds = [...new Set(series.map(s => s.musicId))];
    const tiers = [...new Set(series.map(s => s.tier))].sort((a, b) => a - b);

    const colorFor = new Map<string, string>();
    musicIds.forEach((id, si) => tiers.forEach((t, ti) => colorFor.set(`${id}|${t}`, colorOf(si, ti))));
    const labelFor = (s: CutoffSeries): string => `${cleanText(songs.get(s.musicId)?.musicTitle ?? `#${s.musicId}`)} · 前 ${s.tier}`;

    // 每曲一格的标题带封面 + ID, 一眼看出是哪首
    const panels: Panel[] = [];
    for (const id of musicIds) {
        const song = songs.get(id);
        const name = String(song?.row?.jacketAssetName ?? '');
        const buf = name
            ? await imageBuffer(jacketUrl(song?.server ?? server, name), `images/jacket/${song?.server ?? server}/${name}.webp`)
            : undefined;
        const jacket = buf ? await loadImage(buf).catch(() => undefined) : undefined;
        panels.push({
            title: `${cleanText(song?.musicTitle ?? `#${id}`)} · ID ${id}`,
            jacket,
            series: series.filter(s => s.musicId === id).map(s => ({ series: s, color: colorFor.get(`${s.musicId}|${s.tier}`) ?? '#7ec8ff', label: `前 ${s.tier}` }))
        });
    }
    if (series.length) {
        panels.push({
            title: '三曲同图',
            series: series.map(s => ({ series: s, color: colorFor.get(`${s.musicId}|${s.tier}`) ?? '#7ec8ff', label: `${cleanText(songs.get(s.musicId)?.musicTitle ?? `#${s.musicId}`)}·前 ${s.tier}` }))
        });
    }

    const panelRows = Math.max(1, Math.ceil(panels.length / PANEL_COLUMNS));
    const height = HEADER_H + MARGIN + panelRows * (PANEL_H + PANEL_GAP) + 46 + notes.length * 16 + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, height, { server, bandId: event.backgroundBandId() });
    drawTitle(ctx, WIDTH, '活动榜线 · 分数记录');

    // 副信息带: 国旗 + 服名 + 活动 + 时长
    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, `ID ${event.eventId} ${event.eventName}`, hx, metaMidY, 360);
    hx += Math.min(360, ctx.measureText(`ID ${event.eventId} ${event.eventName}`).width) + 14;
    ctx.fillStyle = '#9aa4b2';
    const range = event.startAt && event.endAt
        ? `${formatDateTime(event.startAt)} ~ ${formatDateTime(event.endAt)}`
        : '活动时间未知';
    fillTextCentered(ctx, range, hx, metaMidY, WIDTH - MARGIN - hx);

    // 横轴整幅预留整个活动时长
    const startMs = event.startAt?.getTime() ?? Date.now();
    const endMs = event.endAt?.getTime() ?? startMs + 24 * 3600_000;
    const span = Math.max(1, endMs - startMs);
    // 四格共用一个纵轴刻度, 便于横向比较
    const yMax = niceMax(Math.max(0, ...series.flatMap(s => s.points.map(p => p.score))) * 1.1);

    if (!panels.length) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('还没有采样记录（服务启动后会按小时采集，也可用本接口触发一次采样）', MARGIN, HEADER_H + MARGIN + 20);
    }
    panels.forEach((panel, i) => {
        const x = MARGIN + (i % PANEL_COLUMNS) * (PANEL_W + MARGIN);
        const y = HEADER_H + MARGIN + Math.floor(i / PANEL_COLUMNS) * (PANEL_H + PANEL_GAP);
        drawPanel(ctx, panel, x, y, startMs, span, yMax);
    });

    // 页脚
    let fy = HEADER_H + MARGIN + panelRows * (PANEL_H + PANEL_GAP) + 12;
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
        `分数 = 该档(第 N 名)在当时的出分，本地按小时采样；上游没有历史接口，数据${cutoffPersistent() ? '存于数据库' : '仅存进程内存（未启用数据库，重启会遗忘）'}`,
        MARGIN, fy, WIDTH - MARGIN * 2);
    fy += 16;
    for (const note of notes) {
        ctx.fillText(note, MARGIN, fy, WIDTH - MARGIN * 2);
        fy += 16;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
