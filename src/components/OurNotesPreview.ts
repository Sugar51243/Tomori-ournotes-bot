import { createCanvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import { CanonicalChart, CanonicalNote, SlideChain } from '../types/Chart';
import { NoteSkin, SpriteDef } from '../data/noteSkin';
import { roundedRectPath, wrapTextLines, adaptText, formatTime } from './draw';
import { logger } from '../logger';
import { FONT_STACK } from './fonts';

/**
 * Our Notes 谱面预览图渲染器。
 * 使用官方素材(livenotes noteSkin 贴图集)绘制音符: tap/flick/slide/trace 精灵 + 九宫格横向拉伸,
 * 滑条按 laneStart..laneEnd 随时间变化绘制成"长条带"(解决长条不明确的问题),
 * 保留: 节拍线/时间轴/BPM 变化线/50 音符计数/fever 背景带(不绘制双押辅助线)。
 */

export interface ChartPreviewHeader {
    id: number;
    title: string;
    artist: string;
    author: string;
    diff: string;
    level: number;
    cover?: Image;
}

export const diffColorList: Record<string, string> = {
    easy: 'rgb(87, 192, 201)',
    normal: 'rgb(138, 201, 87)',
    hard: 'rgb(239, 161, 25)',
    expert: 'rgb(199, 96, 96)',
    special: 'rgb(195, 96, 199)'
};

const LANE_WIDTH = 26;          // 单轨宽度 px
const BLOCK_DISTANCE = 32;      // 列块左右留白
const MIN_HEIGHT = 500;
const MAX_COLUMNS = 60;
/** 置顶信息条: 封面尺寸/边距/列间距(设计单位; 全部随 headerScale 缩放) */
const HEADER_MARGIN = 16;
const HEADER_COVER = 132;
const HEADER_INFO_X = HEADER_MARGIN + HEADER_COVER + HEADER_MARGIN;
const HEADER_COL_GAP = 16;
/** 信息区列数: 标题·乐队·词曲编 | BPM·时长·音符·滑条·预览流速 | 声明 */
const HEADER_COLUMNS = 3;
/** 信息条缩放基准视口宽: 图宽 1000px 时信息条为设计尺寸, 更宽按比例放大 */
const HEADER_VIEWPORT_W = 1000;
/** 信息条整体缩放系数(用户要求: 缩小至现有 0.75 倍) */
const HEADER_SCALE_FACTOR = 0.75;

/** 信息条缩放: 图宽 -> 缩放系数(供渲染与自检脚本共用) */
export function headerScaleFor(width: number): number {
    return Math.max(1, width / HEADER_VIEWPORT_W) * HEADER_SCALE_FACTOR;
}

/**
 * 预览流速: 沿用来源(bdon 谱面检视器)的 NoteSpeed 规则。
 * 来源定义: {name:'NoteSpeed', type:'float', def:'5.00', range:[100,1200]} —— 默认 5.00, 范围 1.00~12.00,
 * 数值越高音符间距越大(可见时间窗越短)。此处按其语义线性映射到 2D 展开图的"每秒高度":
 * 校准为 noteSpeed=5.00 时 648 px/s(与既有默认密度一致)。
 */
export const NOTE_SPEED_DEFAULT = 7.5;
export const NOTE_SPEED_MIN = 1;
export const NOTE_SPEED_MAX = 12;
const PX_PER_SEC_PER_SPEED = 129.6;      // 648 px/s @ noteSpeed 5.00
/** 画布面积上限(px): 高流速 + 长曲时按预算回落流速, 避免内存过大 */
const MAX_CANVAS_PIXELS = 130_000_000;

const PLAYFIELD_BG = '#0B1129';           // 采样自官方 lane_base
const PLAYFIELD_EDGE = 'rgba(120, 170, 220, 0.55)';
const LANE_LINE = 'rgba(255, 255, 255, 0.07)';
const LANE_LINE_STRONG = 'rgba(255, 255, 255, 0.14)';
// 长条(滑条)带: 官方素材为紫蓝色
const SLIDE_FILL = 'rgba(150, 165, 245, 0.16)';
const SLIDE_EDGE = 'rgba(175, 190, 255, 0.5)';
// 素材不可用时的兜底配色(采样自官方精灵: 单键浅蓝 #b2d3e4、长条紫蓝 #a0b4fa、划键左绿/右粉/无方向金)
const NOTE_FALLBACK_FILL: Record<string, string> = {
    Tap: 'rgba(178, 211, 228, 0.92)',
    Flick: 'rgba(240, 200, 127, 0.92)',
    SlideBegin: 'rgba(160, 180, 250, 0.92)',
    SlideBeginFlick: 'rgba(240, 200, 127, 0.92)',
    SlideConnect: 'rgba(135, 159, 242, 0.85)',
    SlideEnd: 'rgba(93, 128, 227, 0.92)',
    SlideEndFlick: 'rgba(240, 200, 127, 0.92)',
    Trace: 'rgba(206, 193, 255, 0.75)'
};
const FLICK_FALLBACK_BY_DIRECTION: Record<string, string> = {
    Normal: 'rgba(240, 200, 127, 0.92)',
    Left: 'rgba(135, 215, 170, 0.92)',
    Right: 'rgba(241, 173, 188, 0.92)'
};
// 长条连击节点的加亮底色(保持紫调, 仅提高明度以区别于长条带; 需配合普通叠加, 加法混合会饱和成白色)
const NODE_BRIGHT_FILL: Record<string, string> = {
    Trace: 'rgba(214, 208, 255, 0.96)',
    SlideConnect: 'rgba(160, 180, 252, 0.96)'
};
const CRITICAL_GOLD = '#FFC94A';
const BPM_LINE = '#E060C8';
const BEAT_LINE = 'rgba(120, 190, 235, 0.35)';
const BEAT_LINE_HALF = 'rgba(120, 190, 235, 0.16)';

export async function drawOurNotesPreview(
    header: ChartPreviewHeader,
    chart: CanonicalChart,
    compress: boolean,
    skin?: NoteSkin,
    noteSpeed: number = NOTE_SPEED_DEFAULT
): Promise<Buffer> {
    const laneCount = chart.laneCount || 24;
    const chartLengthSec = Math.max(1, chart.durationMs / 1000);
    // NoteSpeed -> 每秒高度(线性), 并按画布预算回落
    const speed = Math.min(NOTE_SPEED_MAX, Math.max(NOTE_SPEED_MIN, noteSpeed));
    const wanted = PX_PER_SEC_PER_SPEED * speed;
    const budget = MAX_CANVAS_PIXELS / (688 * chartLengthSec);
    const HEIGHT_PER_SECOND = Math.min(wanted, budget);
    if (wanted > budget) {
        logger('OurNotesPreview', `noteSpeed ${speed} exceeds canvas budget for ${chartLengthSec.toFixed(0)}s chart, using ${HEIGHT_PER_SECOND.toFixed(0)}px/s`);
    }
    const originalWidth = BLOCK_DISTANCE * 2 + LANE_WIDTH * laneCount;
    const originalHeight = HEIGHT_PER_SECOND * chartLengthSec;

    // 列换行(信息条置顶后, 每列演奏区高度 = 总高 - 信息条高)
    const foldColumns = (headerH: number) => {
        let w = BLOCK_DISTANCE * 2 + originalWidth;
        let h = originalHeight + headerH;
        let cols = 1;
        while (w / h < 16 / 9) {
            if (w / h > 4 / 3) break;
            if (Math.ceil(originalHeight / (cols + 1)) < MIN_HEIGHT) break;
            const newW = BLOCK_DISTANCE * 2 + originalWidth * (cols + 1);
            const newH = originalHeight / (cols + 1) + headerH;
            if (newH - headerH < MIN_HEIGHT) break;
            cols++;
            w = newW;
            h = newH;
        }
        if (cols > MAX_COLUMNS) {
            logger('OurNotesPreview', `column count ${cols} exceeds cap ${MAX_COLUMNS}, refusing`);
            throw new Error('chart too long to render');
        }
        return { colCount: cols, width: w, height: h };
    };

    // 置顶信息条按整图比例缩放: 谱面图宽度随列数增长(752~4 万 px), 若信息条用固定字号,
    // 客户端把大图缩到聊天窗口后标题只剩几像素。以 1000px 设计宽为基准, scale = 图宽/1000 × 0.75,
    // 保证任何视口缩放下信息条的观感一致。缩放依赖图宽、图宽依赖列数、列数依赖信息条高, 迭代到稳定。
    let headerScale = headerScaleFor(BLOCK_DISTANCE * 2 + originalWidth);
    let headerLayout = layoutHeader(header, chart, headerScale, (BLOCK_DISTANCE * 2 + originalWidth) / headerScale, noteSpeed, HEIGHT_PER_SECOND);
    let { colCount, width, height } = foldColumns(headerLayout.height);
    for (let i = 0; i < 3; i++) {
        const s = headerScaleFor(width);
        if (Math.abs(s - headerScale) < 0.01) break;
        headerScale = s;
        headerLayout = layoutHeader(header, chart, headerScale, width / headerScale, noteSpeed, HEIGHT_PER_SECOND);
        ({ colCount, width, height } = foldColumns(headerLayout.height));
    }
    const headerH = headerLayout.height;
    const pfHeight = height - headerH;      // 每列演奏区高度
    const secondsPerCol = chartLengthSec / colCount;
    const playfieldW = LANE_WIDTH * laneCount;

    const colOf = (tMs: number) => Math.min(colCount - 1, Math.max(0, Math.floor(tMs / 1000 / secondsPerCol)));
    const colLeft = (col: number) => BLOCK_DISTANCE + col * originalWidth + BLOCK_DISTANCE;
    const xOf = (laneFloat: number, col: number) => colLeft(col) + laneFloat * LANE_WIDTH;
    const yOf = (tMs: number) => headerH + pfHeight - ((tMs / 1000) * HEIGHT_PER_SECOND) % pfHeight;
    // 各列非取模 y: 该列时间范围外的点会落在画布上下方, 用于跨列实体(滑条长条)
    const yOfCol = (tMs: number, col: number) => headerH + pfHeight * (col + 1) - (tMs / 1000) * HEIGHT_PER_SECOND;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // ---- 背景 ----
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    // ---- 演奏区底板 + 轨道线(信息条置顶, 演奏区从 headerH 开始) ----
    for (let col = 0; col < colCount; col++) {
        const x = colLeft(col);
        ctx.fillStyle = PLAYFIELD_BG;
        ctx.fillRect(x, headerH, playfieldW, pfHeight);
        // 轨内分隔线(每 2 轨浅, 每 6 轨深)
        for (let lane = 1; lane < laneCount; lane++) {
            ctx.fillStyle = lane % 6 === 0 ? LANE_LINE_STRONG : LANE_LINE;
            ctx.fillRect(x + LANE_WIDTH * lane, headerH, 1, pfHeight);
        }
        // 外边框
        ctx.fillStyle = PLAYFIELD_EDGE;
        ctx.fillRect(x - 2, headerH, 2, pfHeight);
        ctx.fillRect(x + playfieldW, headerH, 2, pfHeight);
    }

    // ---- fever 背景带 ----
    // 跨列实体: 必须用逐列非取模 y, 否则取模会把超出本列的时间段绕回本列另一端, 使带体边界错位
    for (const seg of chart.fever) {
        const lastCol = colOf(Math.max(seg.startMs, seg.endMs - 1));
        for (let col = colOf(seg.startMs); col <= lastCol; col++) {
            const yStart = yOfCol(seg.startMs, col);
            const yEnd = yOfCol(seg.endMs, col);
            // 与本列可见范围求交(超出本列的部分自然落在画布外)
            const top = Math.max(headerH, Math.min(yStart, yEnd));
            const bottom = Math.min(height, Math.max(yStart, yEnd));
            if (bottom - top < 1) continue;
            const grd = ctx.createLinearGradient(0, yStart, 0, yEnd);
            grd.addColorStop(0, 'rgba(255, 110, 170, 0.18)');
            grd.addColorStop(1, 'rgba(255, 110, 170, 0.07)');
            ctx.fillStyle = grd;
            ctx.fillRect(colLeft(col), top, playfieldW, bottom - top);
        }
    }

    // ---- 节拍线 ----
    for (const seg of chart.bpm) {
        const beatMs = 60000 / seg.bpm;
        for (let beat = 0; ; beat += 0.5) {
            const tMs = seg.timeStartMs + beat * beatMs;
            if (tMs >= seg.timeEndMs || tMs >= chart.durationMs) break;
            const col = colOf(tMs);
            const y = yOf(tMs);
            ctx.save();
            ctx.strokeStyle = beat % 1 === 0 ? BEAT_LINE : BEAT_LINE_HALF;
            ctx.lineWidth = 1;
            if (beat % 1 !== 0) ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(colLeft(col), y);
            ctx.lineTo(colLeft(col) + playfieldW, y);
            ctx.stroke();
            ctx.restore();
        }
    }

    // ---- 时间轴 ----
    ctx.save();
    ctx.textAlign = 'right';
    for (let tMs = 0; tMs <= chart.durationMs; tMs += 5000) {
        const col = colOf(tMs);
        const y = yOf(tMs);
        ctx.font = '17px "Arial"';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        adaptText(ctx, 17, y, height);
        ctx.fillText(formatTime(tMs), colLeft(col) - 8, y);
    }
    ctx.restore();

    // ---- 滑条长条带(音符之下) ----
    for (const slide of chart.slides) {
        drawSlideRibbon(ctx, slide, { colCount, secondsPerCol, colOf, colLeft, xOf, yOf, yOfCol, playfieldW, top: headerH, pfHeight });
    }

    // ---- BPM 变更线 ----
    for (const seg of chart.bpm) {
        const col = colOf(seg.timeStartMs);
        const y = yOf(seg.timeStartMs);
        ctx.fillStyle = BPM_LINE;
        ctx.fillRect(colLeft(col), y - 1, playfieldW, 2);
        ctx.font = '17px "Arial"';
        ctx.fillStyle = '#FFF';
        ctx.textAlign = 'left';
        adaptText(ctx, 17, y, height);
        ctx.fillText(String(seg.bpm), colLeft(col) + playfieldW + 8, y);
    }

    // ---- 每 50 音符计数线 ----
    {
        const ordered = [...chart.notes].sort((a, b) => a.timeMs - b.timeMs);
        ordered.forEach((note, i) => {
            const n = i + 1;
            if (n % 50 !== 0) return;
            const col = colOf(note.timeMs);
            const y = yOf(note.timeMs);
            ctx.fillStyle = 'rgba(150, 150, 150, 0.45)';
            ctx.fillRect(colLeft(col), y - 1, playfieldW, 2);
            ctx.font = '17px "Arial"';
            ctx.fillStyle = '#FFF';
            ctx.textAlign = 'left';
            adaptText(ctx, 17, y, height);
            ctx.fillText(String(n), colLeft(col) + playfieldW + 8, y);
        });
    }

    // ---- 音符(官方精灵) ----
    for (const note of chart.notes) {
        drawNote(ctx, note, skin, { colCount, secondsPerCol, xOf, yOf });
    }

    // ---- 头部信息区(置顶横条, 最后绘制覆盖演奏区顶部) ----
    drawHeader(ctx, header, headerLayout, headerScale);

    return compress ? await canvas.encode('jpeg', 72) : await canvas.encode('png');
}

interface DrawEnv {
    colCount: number;
    secondsPerCol: number;
    xOf: (lane: number, col: number) => number;
    yOf: (tMs: number) => number;
}

/* ---------------- 滑条长条带 ---------------- */

interface RibbonEnv extends DrawEnv {
    colOf: (tMs: number) => number;
    colLeft: (col: number) => number;
    playfieldW: number;
    /** 演奏区顶部 y(信息条高), 用于裁剪带体 */
    top: number;
    /** 每列演奏区高度(裁剪范围) */
    pfHeight: number;
    /** 各列非取模 y: 超出该列时间范围的点落在画布外(避免取模绕回造成的图形反向) */
    yOfCol: (tMs: number, col: number) => number;
}

/** 长条路径点: 每个点带左右边界(随时间变化) */
interface RibbonPoint { timeMs: number; left: number; right: number; }

function ribbonPoints(slide: SlideChain): RibbonPoint[] {
    // 注意: 谱面的 laneStart/laneEnd 为闭区间(宽 = laneEnd - laneStart + 1),
    // 因此带体右边界需取 laneEnd + 1, 否则会比音符窄一个轨道(与音符居中对齐的检查见 scripts/checkGeometry.ts)
    const points: RibbonPoint[] = [
        ...slide.nodes.map(n => ({ timeMs: n.timeMs, left: n.laneStartFloat, right: n.laneEndFloat + 1 })),
        ...slide.trace.map(tp => ({ timeMs: tp.timeMs, left: tp.laneStartFloat, right: tp.laneEndFloat + 1 }))
    ];
    points.sort((a, b) => a.timeMs - b.timeMs);
    return points;
}

function drawSlideRibbon(ctx: SKRSContext2D, slide: SlideChain, env: RibbonEnv): void {
    const points = ribbonPoints(slide);
    if (points.length < 2) return;

    const startCol = env.colOf(slide.beginMs);
    const endCol = env.colOf(Math.max(slide.beginMs, slide.endMs - 1));

    for (let col = startCol; col <= endCol; col++) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(env.colLeft(col) - 2, env.top, env.playfieldW + 4, env.pfHeight);
        ctx.clip();

        // 多边形: 左边沿正序 + 右边沿逆序(各点用本列非取模 y, 跨列部分自然落在画布外)
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = env.xOf(p.left, col);
            const y = env.yOfCol(p.timeMs, col);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        for (let i = points.length - 1; i >= 0; i--) {
            const p = points[i];
            ctx.lineTo(env.xOf(p.right, col), env.yOfCol(p.timeMs, col));
        }
        ctx.closePath();
        ctx.fillStyle = SLIDE_FILL;
        ctx.fill();
        ctx.strokeStyle = SLIDE_EDGE;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }
}

/* ---------------- 音符绘制 ---------------- */

function pickSprite(skin: NoteSkin | undefined, names: string[]): SpriteDef | undefined {
    if (!skin) return undefined;
    for (const n of names) {
        const s = skin.sprites.get(n);
        if (s) return s;
    }
    return undefined;
}

/**
 * Unity 精灵矩形为左下原点, 贴图集按左上原点显示, 需垂直翻转后再采样。
 * (不做翻转会把相邻图形采进来: tap 采成黄绿渐变、trace/slideEnd 区域全透明)
 */
function flipY(skin: NoteSkin, rectY: number, rectH: number): number {
    return skin.atlas.height - (rectY + rectH);
}

/** 九宫格横向拉伸(左右保留边框比例, 中间拉伸) */
function drawNineSlice(ctx: SKRSContext2D, skin: NoteSkin, sprite: SpriteDef, x: number, y: number, w: number, h: number): void {
    const { rect, border } = sprite;
    const sy = flipY(skin, rect.y, rect.height);
    const scale = h / rect.height;
    const lw = Math.min(w / 2, border.left * scale);
    const rw = Math.min(w / 2, border.right * scale);
    const mw = Math.max(0, w - lw - rw);
    const srcMidW = Math.max(0, rect.width - border.left - border.right);
    if (border.left > 0) {
        ctx.drawImage(skin.atlas, rect.x, sy, border.left, rect.height, x, y, lw, h);
    }
    if (srcMidW > 0 && mw > 0) {
        ctx.drawImage(skin.atlas, rect.x + border.left, sy, srcMidW, rect.height, x + lw, y, mw, h);
    }
    if (border.right > 0) {
        ctx.drawImage(skin.atlas, rect.x + rect.width - border.right, sy, border.right, rect.height, x + w - rw, y, rw, h);
    }
}

/** 官方精灵绘制(无边框的直接拉伸) */
function drawSprite(ctx: SKRSContext2D, skin: NoteSkin, sprite: SpriteDef, x: number, y: number, w: number, h: number): void {
    const hasBorder = sprite.border.left > 0 || sprite.border.right > 0;
    if (hasBorder) {
        drawNineSlice(ctx, skin, sprite, x, y, w, h);
    } else {
        const { rect } = sprite;
        ctx.drawImage(skin.atlas, rect.x, flipY(skin, rect.y, rect.height), rect.width, rect.height, x, y, w, h);
    }
}

/**
 * 方向箭头(flick)。
 * - 素材: 官方 LeftFlickNoteAsset(绿) / RightFlickNote(红) / FlickNoteAsset(无方向) 的
 *   _arrowAssets, 按音符**宽度**选取对应档位(游戏同款逻辑, 窄音符用短箭头、宽和弦用长箭头)
 * - 左划素材与右划几何相同, 绘制时对左划做水平镜像, 使箭头指向滑动方向
 */
function drawFlickArrow(
    ctx: SKRSContext2D,
    skin: NoteSkin | undefined,
    cx: number,
    cy: number,
    direction: 'Left' | 'Right' | 'Normal',
    noteW: number,
    noteH: number
): void {
    const widthInLanes = noteW / LANE_WIDTH;   // 音符宽度(轨道数), 官方 _maxWidth 即此单位
    const candidates = skin?.arrowAssets?.[direction] ?? [];
    const arrow = candidates.find(a => widthInLanes <= a.maxWidth) ?? candidates[candidates.length - 1];

    if (!arrow || !skin) {
        // 素材缺失时退化为三角箭头(左绿/右红/无方向金色)
        ctx.fillStyle = direction === 'Left' ? '#4DDF6A' : direction === 'Right' ? '#E8556E' : '#F5C542';
        const s = noteH * 0.7;
        const dir = direction === 'Left' ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + dir * s * 0.5, cy);
        ctx.lineTo(cx - dir * s * 0.5, cy - s * 0.5);
        ctx.lineTo(cx - dir * s * 0.5, cy + s * 0.5);
        ctx.closePath();
        ctx.fill();
        return;
    }

    const { rect } = arrow.sprite;
    const srcY = flipY(skin, rect.y, rect.height);
    // 高度略大于音符; 宽度由该档位素材的固有比例决定(素材已按音符宽度分档, 不会过度拉伸)
    const h = noteH * 1.3;
    const w = h * (rect.width / rect.height);

    ctx.save();
    if (direction === 'Left') {
        // 水平镜像: 箭头指向左
        ctx.translate(cx, cy);
        ctx.scale(-1, 1);
        ctx.drawImage(skin.atlas, rect.x, srcY, rect.width, rect.height, -w / 2, -h / 2, w, h);
    } else {
        ctx.drawImage(skin.atlas, rect.x, srcY, rect.width, rect.height, cx - w / 2, cy - h / 2, w, h);
    }
    ctx.restore();
}

/** 金色描边 + 辉光(critical 音符) */
function drawCriticalGlow(ctx: SKRSContext2D, x: number, y: number, w: number, h: number): void {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 201, 74, 0.9)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = CRITICAL_GOLD;
    ctx.lineWidth = 2;
    roundedRectPath(ctx, x - 1.5, y - 1.5, w + 3, h + 3, Math.min(5, h / 2));
    ctx.stroke();
    ctx.restore();
}

/** 按官方类型选择音符主体精灵(划键按方向取专属素材; 滑条头尾的划键也走划键渲染) */
function pickBodySprite(skin: NoteSkin, note: CanonicalNote): SpriteDef | undefined {
    const b = skin.bodies;
    switch (note.type) {
        case 'Tap': return b.tap;
        case 'SlideBegin': return b.slide;
        case 'SlideConnect': return b.slideConnect;
        case 'SlideEnd': return b.slideEnd;
        case 'Trace': return b.trace;
        case 'Flick':
        case 'SlideBeginFlick':
        case 'SlideEndFlick':
            // 方向划键使用专属身体素材(左划绿/右划粉红), 无方向为金色
            if (note.direction === 'Left') return b.flickLeft ?? b.flick;
            if (note.direction === 'Right') return b.flickRight ?? b.flick;
            return b.flick;
        default: return undefined;
    }
}

/** 是否为划键类(需要绘制方向箭头) */
function isFlickType(type: CanonicalNote['type']): boolean {
    return type === 'Flick' || type === 'SlideBeginFlick' || type === 'SlideEndFlick';
}

function drawNote(ctx: SKRSContext2D, note: CanonicalNote, skin: NoteSkin | undefined, env: DrawEnv): void {
    // Combo(op120)为滑条路径上的连击计数点, 游戏中不作为音符显示;
    // 其余判定音符(op1/20/21/22/40/41/42/62/63/101 等)均需绘制
    // (注: op101 GuideBeginNormal 的 visible=false 并不表示不显示, 仍需按普通音符渲染)
    if (note.type === 'Combo') return;

    const col = Math.min(env.colCount - 1, Math.floor(note.timeMs / 1000 / env.secondsPerCol));
    const x = env.xOf(note.laneStartFloat, col);
    const w = Math.max(LANE_WIDTH * 0.6, (note.laneEndFloat - note.laneStartFloat + 1) * LANE_WIDTH);
    const centerY = env.yOf(note.timeMs);

    const sprite = skin ? pickBodySprite(skin, note) : undefined;
    const isNode = note.type === 'SlideConnect' || note.type === 'Trace';

    if (isNode) {
        // 长条上的连击节点(SlideConnect / Trace): 尺寸小于普通音符, 并做加亮处理便于辨认
        // (仅影响长条节点; op101 Guide 类仍按普通单键渲染, 不受此分支影响)
        const h = LANE_WIDTH * 0.7;
        const sw = Math.min(w * 0.85, LANE_WIDTH * 1.15);
        const sx = x + (w - sw) / 2;
        const sy = centerY - h / 2;
        // 亮色底(保持紫调) + 轻外发光
        ctx.save();
        ctx.shadowColor = 'rgba(190, 180, 255, 0.75)';
        ctx.shadowBlur = 4;
        ctx.fillStyle = NODE_BRIGHT_FILL[note.type] ?? NODE_BRIGHT_FILL.Trace;
        roundedRectPath(ctx, sx, sy, sw, h, 3);
        ctx.fill();
        ctx.restore();
        // 叠加官方精灵纹理(普通叠加, 保留官方明暗且不溢出为白色)
        if (sprite && skin) {
            ctx.save();
            ctx.globalAlpha = 0.55;
            drawSprite(ctx, skin, sprite, sx, sy, sw, h);
            ctx.restore();
        }
        return;
    }

    const h = LANE_WIDTH * 0.86;
    const y = centerY - h / 2;

    if (sprite && skin) {
        // 官方精灵已自带配色(单键浅蓝/长条紫蓝/划键按方向着色)
        drawSprite(ctx, skin, sprite, x, y, w, h);
    } else {
        ctx.fillStyle = isFlickType(note.type)
            ? (FLICK_FALLBACK_BY_DIRECTION[note.direction ?? 'Normal'] ?? NOTE_FALLBACK_FILL.Flick)
            : (NOTE_FALLBACK_FILL[note.type] ?? NOTE_FALLBACK_FILL.Tap);
        roundedRectPath(ctx, x, y, w, h, 4);
        ctx.fill();
    }

    // 划键箭头(含长条头尾的划键): 左划绿(镜像向左)、右划红、无方向金色
    if (isFlickType(note.type)) {
        drawFlickArrow(ctx, skin, x + w / 2, centerY, note.direction ?? 'Normal', w, h);
    }
    // 装饰图标(tap 中心纹样): 半透明小标记, 避免喧宾夺主
    if (note.type === 'Tap') {
        const deco = pickSprite(skin, ['tap_decoration']);
        if (deco && skin && w > LANE_WIDTH * 1.2) {
            const dh = Math.min(h * 0.62, LANE_WIDTH * 0.6);
            const dw = dh * (deco.rect.width / deco.rect.height);
            ctx.globalAlpha = 0.5;
            ctx.drawImage(skin.atlas, deco.rect.x, flipY(skin, deco.rect.y, deco.rect.height), deco.rect.width, deco.rect.height, x + w / 2 - dw / 2, centerY - dh / 2, dw, dh);
            ctx.globalAlpha = 1;
        }
    }

    // critical 金色强调
    if (note.critical) {
        drawCriticalGlow(ctx, x, y, w, h);
    }
}

/* ---------------- 头部信息(置顶横条) ---------------- */

/** 信息条一列里的一段文本(字号/行高/颜色为设计单位, 随 scale 缩放) */
interface HeaderTextBlock {
    kind: 'text';
    size: number;
    lineH: number;
    color: string;
    bold?: boolean;
    lines: string[];
    /** 与上一段之间的间距(设计单位) */
    gapBefore: number;
}

/** 两列表格块(标签列 | 数值列; 数值过长时自身折行) */
interface HeaderTableBlock {
    kind: 'table';
    size: number;
    lineH: number;
    labelColor: string;
    valueColor: string;
    /** 标签列宽(设计单位) */
    labelW: number;
    rows: { label: string; lines: string[] }[];
    gapBefore: number;
}

type HeaderBlock = HeaderTextBlock | HeaderTableBlock;

/** 置顶信息条排版结果(测量与绘制共用, 保证换行与高度一致) */
export interface HeaderLayout {
    height: number;
    /** 列宽(设计单位) */
    colW: number;
    /** 各列: 0 标题·乐队 / 1 词曲编 / 2 BPM·时长 / 3 音符·滑条 / 4 预览流速 / 5 声明 */
    columns: HeaderBlock[][];
}

/**
 * 信息条排版: 左封面(带 ID/难度徽章) + 信息区**三列** ——
 *   列1 标题 26px 加粗·乐队 16px·作词作曲编曲 14px;
 *   列2 BPM·时长·音符·滑条·预览流速 15px;
 *   列3 声明 11px。
 * 列宽按可用宽度均分(内容宽 = 图宽/scale, 随图宽自适应, 窄图不会被裁切);
 * 所有尺寸/字号/行高 × scale, 高度 = max(封面高 + 边距, 最高一列 + 边距)。
 */
export function layoutHeader(
    header: ChartPreviewHeader,
    chart: CanonicalChart,
    scale: number,
    contentWidth: number,
    noteSpeed: number,
    heightPerSecond: number
): HeaderLayout {
    const s = scale;
    const colW = Math.floor((contentWidth - HEADER_INFO_X - HEADER_MARGIN - HEADER_COL_GAP * (HEADER_COLUMNS - 1)) / HEADER_COLUMNS);
    const probe = createCanvas(10, 10).getContext('2d');
    /** 按字号换行(字号/列宽均为设计单位, 测量时换算成 px) */
    const wrap = (text: string, size: number, maxLines: number, width = colW): string[] => {
        probe.font = `${size * s}px ${FONT_STACK}`;
        return wrapTextLines(probe, text, width * s, maxLines);
    };

    // 列1: 标题 + 乐队 + 词曲编
    const columns: HeaderBlock[][] = [[
        { kind: 'text', size: 26, lineH: 34, color: '#FFF', bold: true, lines: wrap(header.title, 26, 2), gapBefore: 0 }
    ]];
    if (header.artist) {
        columns[0].push({ kind: 'text', size: 16, lineH: 24, color: '#BBB', lines: wrap(header.artist, 16, 2), gapBefore: 4 });
    }
    const authorLines: string[] = [];
    for (const line of header.author.split('\n')) {
        if (!line) continue;
        for (const wrapped of wrap(line, 14, 2)) authorLines.push(wrapped);
        if (authorLines.length >= 6) break;
    }
    columns[0].push({ kind: 'text', size: 14, lineH: 20, color: '#9aa4b2', lines: authorLines, gapBefore: 8 });

    // 列2: 数据表(标签 | 数值), 字号放大
    const bpmRange = chart.bpm.length === 1
        ? `${chart.bpm[0].bpm}`
        : `${Math.min(...chart.bpm.map(b => b.bpm))}~${Math.max(...chart.bpm.map(b => b.bpm))}`;
    // 预览流速: 若因画布预算回落则标注实际值
    const speedText = Math.abs(heightPerSecond - PX_PER_SEC_PER_SPEED * noteSpeed) > 1
        ? `${noteSpeed.toFixed(2)} (降为 ${(heightPerSecond / PX_PER_SEC_PER_SPEED).toFixed(2)})`
        : noteSpeed.toFixed(2);
    const stats: [string, string][] = [
        ['BPM', bpmRange],
        ['时长', formatTime(chart.durationMs)],
        ['音符', String(chart.fullComboCount || chart.judgementNoteCount)],
        ['滑条', String(chart.slides.length)],
        ['预览流速', speedText]
    ];
    const statsSize = 24;
    probe.font = `${statsSize * s}px ${FONT_STACK}`;
    const labelW = Math.ceil(Math.max(...stats.map(([label]) => probe.measureText(label).width)) / s) + 14;
    const valueW = Math.max(40, colW - labelW);
    columns.push([{
        kind: 'table', size: statsSize, lineH: 32, gapBefore: 0,
        labelColor: '#9aa4b2', valueColor: '#FFF', labelW,
        rows: stats.map(([label, value]) => ({ label, lines: wrap(value, statsSize, 3, valueW) }))
    }]);

    // 列3: 声明
    columns.push([{ kind: 'text', size: 11, lineH: 15, color: '#777', lines: wrap('本图由 Tomori 生成 · 谱面与素材来自 BanG Dream! Our Notes · 仅供学习交流使用', 11, 4), gapBefore: 0 }]);

    let textH = 0;
    for (const col of columns) {
        let h = 0;
        for (const block of col) {
            h += block.gapBefore + (block.kind === 'table'
                ? block.rows.reduce((sum, row) => sum + row.lines.length * block.lineH, 0)
                : block.lines.length * block.lineH);
        }
        textH = Math.max(textH, h);
    }
    const height = Math.max((HEADER_COVER + HEADER_MARGIN * 2) * s, textH * s + HEADER_MARGIN * 2 * s);
    return { height, colW, columns };
}

function drawHeader(ctx: SKRSContext2D, header: ChartPreviewHeader, layout: HeaderLayout, scale: number): void {
    const s = scale;
    const margin = HEADER_MARGIN * s;
    const coverW = HEADER_COVER * s;
    const colW = layout.colW * s;
    const colX = (i: number) => (HEADER_INFO_X + i * (layout.colW + HEADER_COL_GAP)) * s;
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, ctx.canvas.width, layout.height);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, layout.height - Math.max(1, s), ctx.canvas.width, Math.max(1, s));

    // 封面 + id/难度徽章
    ctx.fillStyle = '#222';
    ctx.fillRect(margin, margin, coverW, coverW);
    if (header.cover) {
        try {
            ctx.drawImage(header.cover, margin, margin, coverW, coverW);
        } catch { /* 封面失败画占位 */ }
    }
    ctx.fillStyle = '#1f1e33';
    ctx.fillRect(margin, margin, 96 * s, 22 * s);
    ctx.fillStyle = '#FFF';
    ctx.font = `${15 * s}px "Arial"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(header.id), margin + 48 * s, margin + 11 * s, 96 * s);
    const diffColor = diffColorList[header.diff] ?? diffColorList.expert;
    ctx.fillStyle = diffColor;
    ctx.fillRect(margin + coverW - 100 * s, margin + coverW - 26 * s, 100 * s, 26 * s);
    ctx.fillStyle = '#FFF';
    ctx.font = `bold ${16 * s}px "Arial"`;
    ctx.fillText(`${header.diff} ${header.level}`, margin + coverW - 50 * s, margin + coverW - 13 * s, 100 * s);

    // 信息区各列
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    layout.columns.forEach((blocks, i) => {
        let y = margin;
        for (const block of blocks) {
            y += block.gapBefore * s;
            if (block.kind === 'table') {
                // 两列数据表: 标签列固定宽, 数值列右接
                for (const row of block.rows) {
                    const rowTop = y;
                    ctx.fillStyle = block.labelColor;
                    ctx.font = `${block.size * s}px ${FONT_STACK}`;
                    ctx.fillText(row.label, colX(i), rowTop, block.labelW * s);
                    ctx.fillStyle = block.valueColor;
                    for (const line of row.lines) {
                        ctx.fillText(line, colX(i) + block.labelW * s, y, (colW - block.labelW) * s);
                        y += block.lineH * s;
                    }
                }
            } else {
                ctx.fillStyle = block.color;
                ctx.font = `${block.bold ? 'bold ' : ''}${block.size * s}px ${FONT_STACK}`;
                for (const line of block.lines) {
                    ctx.fillText(line, colX(i), y, colW);
                    y += block.lineH * s;
                }
            }
        }
    });
}
