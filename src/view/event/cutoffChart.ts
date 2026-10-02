import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas';
import { config } from '../../config';
import { Event } from '../../types/Event';
import { Server, serverProfile } from '../../types/Server';
import { Song } from '../../types/Song';
import { CutoffMeta, CutoffSeries } from '../../types/Cutoff';
import { formatGameDate } from '../../types/Gacha';
import { cutoffPersistent } from '../../data/cutoff/store';
import { imageBuffer, jacketUrl } from '../../data/assets';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../components/list';
import { drawBackground } from '../../components/background';
import { drawServerIcon } from '../../components/serverIcon';
import { fillTextCentered, formatAgo, formatDateTime, cleanText, roundedRectPath } from '../../components/draw';
import { cjkFontFamily } from '../../components/fonts';

/**
 * 活动榜线 · 折线图(**一张图: 每曲一格 + 三曲同图**)。
 *
 * 横轴**铺满整个活动时长**(开启 → 结束), 纵轴是分数; 每条线 = 某曲的某一档(前 10 / 前 100 …),
 * 同一条线在各格用同一个颜色, 方便对照。
 *
 * 纵轴**恒以 0 为基准**, 只按数据动态挑刻度间隔(`zeroBasedRange`); 每曲一格各自定标,
 * 「三曲同图」那格用三曲合起来的刻度(保留曲与曲之间的高低关系), 且满宽 + 加高, 图例折行不截断。
 * 异常高值(上游脏数据, 例如顶到 int32 极限、与现有分数差几个数量级)不参与定标, 画的时候
 * **贴顶用 ▲ 标出、不渲染超出表格的部分**(`outlierFence` + `placePoints`)。
 *
 * 数据是本地按小时采样的历史(上游没有历史接口): 没启用数据库时只在内存里, 重启会遗忘, 页脚会标注。
 * 页脚另有「上游数据更新 / Tomori 记录」一行, 说明这批数据有多新(见 freshnessLine)。
 */

const WIDTH = 980;
const MARGIN = 16;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
/** 绘图区高度(不含头部与图例; 含横轴日期标签的高度) */
const PANEL_PLOT_H = 210;
const PANEL_GAP = 14;
const PANEL_COLUMNS = 2;
const PANEL_W = (WIDTH - MARGIN * (PANEL_COLUMNS + 1)) / PANEL_COLUMNS;
/** 满宽格(三曲同图)的宽度 */
const FULL_W = WIDTH - MARGIN * 2;
/** 单格头部(封面 22 + 间距): 绘图区从这里往下, 免得封面/标题压到坐标轴上 */
const PANEL_HEADER_H = 26;
/** 横轴日期标签占的高度 */
const AXIS_LABEL_H = 26;
/** 图例每行的高度 */
const LEGEND_ROW_H = 16;
/** 图例最多折几行 */
const LEGEND_MAX_ROWS = 4;
/** 采样点之间的间隔超过这个倍数的记录间隔就断开(表示那段没采到) */
const GAP_FACTOR = 3;
/** 正常采样间隔 = 桶粒度与定时采样间隔的较大者(跟着配置走, 不再是硬编码的一小时) */
const SAMPLE_INTERVAL_MS = Math.max(1, config.cutoffBucketS, config.cutoffRecordIntervalS) * 1000;
const GAP_MS = SAMPLE_INTERVAL_MS * GAP_FACTOR;

/** 线的配色: 每曲一色系, 档位用深浅区分(同一条线在各格里颜色一致) */
const SONG_COLORS = ['#7ec8ff', '#ffd76e', '#8fd0a0', '#ff9bb0', '#c9a6ff'];
const TIER_ALPHA = [1, 0.55, 0.35, 0.25, 0.2];

function colorOf(songIndex: number, tierIndex: number): string {
    const base = SONG_COLORS[songIndex % SONG_COLORS.length];
    const alpha = TIER_ALPHA[Math.min(tierIndex, TIER_ALPHA.length - 1)];
    if (alpha >= 1) return base;
    // 用 hex + alpha 通道让同曲不同档深浅可辨
    return base + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

interface Range {
    min: number;
    max: number;
    step: number;
}

/** 纵轴恒以 0 为基准: 只按数据挑「好看」的刻度间隔(1/2/2.5/5 × 10^k), 上界取到不超过 targetTicks 段 */
function zeroBasedRange(hi: number, targetTicks = 4): Range {
    if (!Number.isFinite(hi) || hi <= 0) return { min: 0, max: 1, step: 0.25 };
    const rawStep = hi / targetTicks;
    const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / pow;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * pow;
    return { min: 0, max: Math.max(step, Math.ceil(hi / step) * step), step };
}

/**
 * 异常值判定(Tukey 远端栅栏 Q3 + 3×IQR): 超过这条线的采样视为脏数据(例如上游给到 int32 极限,
 * 与现有分数差了几个数量级)。它们**不参与纵轴定标**, 画的时候贴顶显示(见 drawPanel)。
 * 点太少(< 8)不判异常, 免得把正常的一大段都当成离群。
 */
function outlierFence(scores: number[]): number {
    if (scores.length < 8) return Number.POSITIVE_INFINITY;
    const sorted = [...scores].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const q1 = at(0.25);
    const q3 = at(0.75);
    return q3 + 3 * (q3 - q1);
}

/** 轴标签: 按刻度步长决定小数位, 免得相邻刻度都显示成同一个「万/亿」 */
function fmtAxis(v: number, step: number): string {
    const decimals = (unit: number): number => {
        const s = step / unit;
        if (s >= 1) return 0;
        return Math.min(2, Math.ceil(-Math.log10(s)));
    };
    const abs = Math.abs(v);
    if (abs >= 1e8) return `${(v / 1e8).toFixed(decimals(1e8))}亿`;
    if (abs >= 1e4) return `${(v / 1e4).toFixed(decimals(1e4))}万`;
    return String(Math.round(v));
}

interface PanelLine {
    series: CutoffSeries;
    color: string;
    label: string;
}

interface Panel {
    title: string;
    /** 曲目封面(三曲同图那格没有); 解码好的 Image, 绘制阶段不能再 await */
    jacket?: Image;
    lines: PanelLine[];
    /** 跨两列的宽格(三曲同图): 线多、图例长, 半格放不下 */
    fullWidth?: boolean;
    /** 绘图区加高(宽格用, 纵向分辨率更足) */
    tall?: boolean;
}

/** 要画的点; 图例按 PanelLine 全量列出 */
interface PlottedLine {
    line: PanelLine;
    points: Array<{ at: number; score: number }>;
}

interface PanelBox {
    panel: Panel;
    x: number;
    y: number;
    w: number;
    h: number;
    plotH: number;
    legendH: number;
    range: Range;
    plotted: PlottedLine[];
    /** 超出纵轴上界、贴顶显示的采样键(musicId|tier|at) */
    clipped: Set<string>;
}

/** 图例要折几行(按实际文字宽度量, 不再「放不下就截断」) */
function legendRowCount(panel: Panel, plotW: number, ctx: SKRSContext2D): number {
    ctx.font = cjkFontFamily(11);
    let used = 0;
    let rows = 1;
    for (const line of panel.lines) {
        const w = ctx.measureText(line.label).width + 26;
        if (used > 0 && used + w > plotW) {
            rows++;
            used = 0;
        }
        used += w;
    }
    return Math.max(1, Math.min(rows, LEGEND_MAX_ROWS));
}

/**
 * 定标与取点: 纵轴**恒以 0 为基准**(只动态挑刻度间隔), 上界取正常数据的最大值;
 * 异常高值(见 outlierFence)不参与定标, 画的时候贴顶截断 —— 数据一条不丢(最新 10 条自然在内),
 * 只是超出表格的部分不渲染。
 */
function placePoints(lines: PanelLine[]): { plotted: PlottedLine[]; range: Range; clipped: Set<string> } {
    const plotted: PlottedLine[] = lines.map(l => ({ line: l, points: l.series.points }));
    const scores = plotted.flatMap(l => l.points.map(p => p.score)).filter(Number.isFinite);
    if (!scores.length) return { plotted, range: zeroBasedRange(1), clipped: new Set() };

    const fence = outlierFence(scores);
    const normalHi = scores.filter(s => s <= fence).reduce((m, s) => Math.max(m, s), 0);
    const range = zeroBasedRange(normalHi * 1.02);

    const clipped = new Set<string>();
    for (const l of plotted) {
        for (const p of l.points) {
            if (p.score > range.max) clipped.add(`${l.line.series.musicId}|${l.line.series.tier}|${p.at}`);
        }
    }
    return { plotted, range, clipped };
}

/** 画一格: 标题(带封面/ID) + 坐标轴 + 折线 + 图例 */
function drawPanel(
    ctx: SKRSContext2D,
    box: PanelBox,
    startMs: number,
    span: number
): void {
    const { panel, x, y, w, h, plotH, legendH, range, plotted } = box;
    const plotX = x + 58;
    const plotY = y + PANEL_HEADER_H;
    const plotW = w - 58 - 8;
    const xOf = (at: number) => plotX + Math.min(1, Math.max(0, (at - startMs) / span)) * plotW;
    const spanY = Math.max(1e-9, range.max - range.min);
    const yOf = (score: number) => plotY + plotH - Math.min(1, Math.max(0, (score - range.min) / spanY)) * plotH;

    // 纯色打底: 折线要压在背景图上看, 不给底会看不清
    ctx.fillStyle = 'rgba(12, 14, 24, 0.82)';
    roundedRectPath(ctx, x, y, w, h, 6);
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
    ctx.fillText(panel.title, titleX, y + 2, x + w - titleX);

    // 超出上界的采样贴顶画一个三角标(数值本身不渲染到表格外)
    const markOverflow = (at: number): void => {
        const px = xOf(at);
        ctx.beginPath();
        ctx.moveTo(px, plotY + 1);
        ctx.lineTo(px - 4.5, plotY + 8);
        ctx.lineTo(px + 4.5, plotY + 8);
        ctx.closePath();
        ctx.fill();
    };

    // 纵轴刻度 + 横网格(刻度按本格数据动态取, 不再是固定的 0 ~ yMax 四等分)
    ctx.font = cjkFontFamily(10);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
        const v = range.min + range.step * i;
        if (v > range.max + range.step * 1e-6) break;
        const gy = yOf(v);
        ctx.beginPath();
        ctx.moveTo(plotX, gy + 0.5);
        ctx.lineTo(plotX + plotW, gy + 0.5);
        ctx.stroke();
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(fmtAxis(v, range.step), plotX - 6, gy, 50);
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
    for (const { line, points } of plotted) {
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        let prevAt = 0;
        for (const p of points) {
            const px = xOf(p.at);
            const py = yOf(p.score);
            if (!started || p.at - prevAt > GAP_MS) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
            started = true;
            prevAt = p.at;
        }
        ctx.stroke();

        // 采样点: 画得下才逐点画圆点; 太密就只画线, 否则圆点糊成一条毛毛虫。
        // 无论如何都把**最新的点**标出来(当前档位分数); 超界的点一律用三角标代替圆点。
        ctx.fillStyle = line.color;
        const n = points.length;
        const pxSpan = n > 1 ? Math.abs(xOf(points[n - 1].at) - xOf(points[0].at)) / (n - 1) : Infinity;
        if (n === 1 || pxSpan >= 6) {
            for (const p of points) {
                if (p.score > range.max) {
                    markOverflow(p.at);
                    continue;
                }
                ctx.beginPath();
                ctx.arc(xOf(p.at), yOf(p.score), 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (n > 1) {
            const last = points[n - 1];
            if (last.score > range.max) {
                markOverflow(last.at);
            } else {
                ctx.beginPath();
                ctx.arc(xOf(last.at), yOf(last.score), 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    // 图例: 放不下就换行(多行), 绝不丢条目
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = cjkFontFamily(11);
    let lx = plotX;
    let ly = y + h - legendH + LEGEND_ROW_H / 2;
    for (const line of panel.lines) {
        const textW = ctx.measureText(line.label).width;
        const needW = textW + 26;
        if (lx > plotX && lx + needW > plotX + plotW) {
            lx = plotX;
            ly += LEGEND_ROW_H;
        }
        ctx.fillStyle = line.color;
        ctx.fillRect(lx, ly - 4, 12, 8);
        ctx.fillStyle = '#DDD';
        ctx.fillText(line.label, lx + 16, ly, Math.max(24, plotX + plotW - lx - 16));
        lx += needW;
    }
}

/**
 * 页脚的数据新鲜度行: 上游数据什么时候抓的(解自 ETag) + Tomori 什么时候记的。
 * 时间按**区域时区**显示(与公告图一致); 老文档缺字段时降级为"未知", 一个采样点都没有时不画这行。
 */
function freshnessLine(server: Server, series: CutoffSeries[], meta: CutoffMeta): string | undefined {
    if (!series.length) return undefined;
    const now = Date.now();
    const stamp = (ms: number): string => `${formatGameDate(new Date(ms), server)}（${formatAgo(ms, now)}）`;
    // 上游只给绝对时间(其时钟可能略快于本机, 标「上游时间」而不算"多久前", 免得出现负龄)
    const upstream = meta.lastUpstreamAt
        ? `上游数据更新 ${formatGameDate(new Date(meta.lastUpstreamAt), server)}（上游时间）`
        : '上游更新时间未知（历史数据）';
    const recorded = meta.lastRecordedAt
        ? `Tomori 记录 ${stamp(meta.lastRecordedAt)}`
        : 'Tomori 记录时间未知（历史数据）';
    return `${upstream} · ${recorded}`;
}

export async function drawCutoffChart(
    server: Server,
    event: Event,
    series: CutoffSeries[],
    songs: Map<number, Song>,
    compress: boolean,
    notes: string[] = [],
    meta: CutoffMeta = {}
): Promise<Array<Buffer | string>> {
    // 每曲一格 + 最后一格三曲同图(满宽)
    const musicIds = [...new Set(series.map(s => s.musicId))];
    const tiers = [...new Set(series.map(s => s.tier))].sort((a, b) => a - b);

    const colorFor = new Map<string, string>();
    musicIds.forEach((id, si) => tiers.forEach((t, ti) => colorFor.set(`${id}|${t}`, colorOf(si, ti))));

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
            lines: series.filter(s => s.musicId === id).map(s => ({ series: s, color: colorFor.get(`${s.musicId}|${s.tier}`) ?? '#7ec8ff', label: `前 ${s.tier}` }))
        });
    }
    if (series.length) {
        panels.push({
            title: '三曲同图',
            fullWidth: true,
            tall: true,
            lines: series.map(s => ({ series: s, color: colorFor.get(`${s.musicId}|${s.tier}`) ?? '#7ec8ff', label: `${cleanText(songs.get(s.musicId)?.musicTitle ?? `#${s.musicId}`)} · 前 ${s.tier}` }))
        });
    }

    // 先量尺寸再定画布高度: 图例折行数决定每格多高
    const measure = createCanvas(1, 1).getContext('2d');
    const boxes: PanelBox[] = [];
    let cursorY = HEADER_H + MARGIN;
    let col = 0;
    let rowMaxH = 0;
    /** 超界的采样(同一序列在单曲格与三曲同图格都会出现, 用集合去重后再报数) */
    const clippedAll = new Set<string>();
    for (const panel of panels) {
        if (panel.fullWidth && col !== 0) {
            cursorY += rowMaxH + PANEL_GAP;
            col = 0;
            rowMaxH = 0;
        }
        const w = panel.fullWidth ? FULL_W : PANEL_W;
        const plotW = w - 58 - 8;
        const plotH = PANEL_PLOT_H - AXIS_LABEL_H + (panel.tall ? 46 : 0);
        const legendH = legendRowCount(panel, plotW, measure) * LEGEND_ROW_H;
        const h = PANEL_HEADER_H + plotH + AXIS_LABEL_H + legendH + 6;
        const { plotted, range, clipped } = placePoints(panel.lines);
        for (const key of clipped) clippedAll.add(key);
        boxes.push({
            panel, x: MARGIN + col * (PANEL_W + MARGIN), y: cursorY, w, h, plotH, legendH,
            range, plotted, clipped
        });

        if (panel.fullWidth) {
            cursorY += h + PANEL_GAP;
            col = 0;
            rowMaxH = 0;
        } else {
            rowMaxH = Math.max(rowMaxH, h);
            col++;
            if (col >= PANEL_COLUMNS) {
                cursorY += rowMaxH + PANEL_GAP;
                col = 0;
                rowMaxH = 0;
            }
        }
    }
    const contentBottom = Math.max(
        HEADER_H + MARGIN + 40,
        col === 0 ? cursorY - PANEL_GAP : cursorY + rowMaxH
    );
    // 页脚先成行再定画布高度: 行数决定高度, 免得新加一行被画到画布外
    const footerLines: string[] = [];
    const freshness = freshnessLine(server, series, meta);
    if (freshness) footerLines.push(freshness);
    footerLines.push(`分数 = 该档(第 N 名)在当时的出分，本地按小时采样；纵轴以 0 为基准、刻度间隔按数据自适应；数据${cutoffPersistent() ? '存于数据库' : '仅存进程内存（未启用数据库，重启会遗忘）'}`);
    if (clippedAll.size) {
        footerLines.push(`注：有 ${clippedAll.size} 个采样值超出图表范围（异常数据，如上游给到 int32 极限），已贴顶用 ▲ 标出、不渲染超出部分`);
    }
    footerLines.push(...notes);
    // 首行基线在 contentBottom+12, 行距 16, 末尾留 18 的富余 —— 与旧公式(contentBottom+46+…)等价
    const height = contentBottom + 12 + footerLines.length * 16 + 18 + MARGIN;
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
    const periodText = event.startAt && event.endAt
        ? `${formatDateTime(event.startAt)} ~ ${formatDateTime(event.endAt)}`
        : '活动时间未知';
    fillTextCentered(ctx, periodText, hx, metaMidY, WIDTH - MARGIN - hx);

    // 横轴整幅预留整个活动时长
    const startMs = event.startAt?.getTime() ?? Date.now();
    const endMs = event.endAt?.getTime() ?? startMs + 24 * 3600_000;
    const span = Math.max(1, endMs - startMs);

    if (!boxes.length) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('还没有采样记录（服务启动后会按小时采集，也可用本接口触发一次采样）', MARGIN, HEADER_H + MARGIN + 20);
    }
    for (const box of boxes) {
        drawPanel(ctx, box, startMs, span);
    }

    // 页脚
    let fy = contentBottom + 12;
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const line of footerLines) {
        ctx.fillText(line, MARGIN, fy, WIDTH - MARGIN * 2);
        fy += 16;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
