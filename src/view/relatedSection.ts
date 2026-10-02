import { loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Server } from '../types/Server';
import { RelatedGacha, RelatedEvent } from '../data/relations';
import { drawSectionTitle, SECTION_TITLE_H } from '../components/list';
import { eventAssetImage } from './event/eventArt';

/**
 * 「相关卡池 / 相关活动」栏位: 缩图网格, **图片右下角叠一个黑底 ID 徽章**(不画名称)。
 *
 * 与 songDetail / cardDetail 一样遵循**先量后画**: 高度只由网格常量决定,
 * 与缩图能否取到无关 —— 所以量高阶段调 `relatedSectionHeight()`(纯计算, 不碰图片),
 * 绘制阶段才 `drawRelatedSection()` 去取图。两次的布局由同一个 `relatedLayout()` 保证一致。
 *
 * 缩图走 `eventAssetImage` 的**逐区域回退**(上游各区域素材镜像进度不一,
 * 实测新卡面/新活动图在 tw/kr/en 上常是 404, 只有 jp 齐全)。
 */

const TITLE_GAP = 6;          // 标题行底边到网格顶部的间距
const GAP = 10;               // 卡片之间的横纵间距
const IMAGE_MAX_H = 130;
const TILE_MIN_W = 210;       // 决定每行放几个
const BADGE_H = 22;

type Ctx = SKRSContext2D;

export interface RelatedLayout {
    perRow: number;
    tileW: number;
    imageH: number;
    /** 单个卡片的总高: 没有说明区, 就等于缩图高 */
    tileH: number;
}

/** 由可用宽度推出网格布局(量高与绘制共用, 保证两次排版一致) */
export function relatedLayout(width: number): RelatedLayout {
    const perRow = Math.max(1, Math.floor((width + GAP) / (TILE_MIN_W + GAP)));
    const tileW = (width - GAP * (perRow - 1)) / perRow;
    const imageH = Math.min(IMAGE_MAX_H, Math.round(tileW * 0.45));
    return { perRow, tileW, imageH, tileH: imageH };
}

/**
 * 栏位占用的总高度(标题行 + 网格); count 为 0 时不占任何高度(调用方据此跳过整个栏位)。
 * 与 `drawRelatedSection` 的返回值增量严格一致 —— 否则「先画后量」会算错画布高度。
 */
export function relatedSectionHeight(width: number, count: number): number {
    if (count <= 0) return 0;
    const { perRow, tileH } = relatedLayout(width);
    return SECTION_TITLE_H + TITLE_GAP + Math.ceil(count / perRow) * (tileH + GAP);
}

/** 缩图按原始比例贴合框内(不拉伸), 居中 */
function drawFit(ctx: Ctx, img: Awaited<ReturnType<typeof loadImage>>, x: number, y: number, w: number, h: number): void {
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 图片右下角的黑底 ID 徽章(叠在缩图之上) */
function drawCornerIdBadge(ctx: Ctx, x: number, y: number, w: number, h: number, id: number): void {
    const label = String(id);
    ctx.font = '14px "Arial"';
    const bw = Math.max(44, ctx.measureText(label).width + 18);
    const bx = x + w - bw;
    const by = y + h - BADGE_H;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(bx, by, bw, BADGE_H);
    ctx.fillStyle = '#FFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + BADGE_H / 2, bw - 8);
}

export interface RelatedItem {
    id: number;
    name: string;
    imagePath: string;
    imageCacheKey: string;
}

/** 卡池与活动的关联结果形状一致, 这里统一收口 */
export function toRelatedItems(items: Array<RelatedGacha | RelatedEvent>): RelatedItem[] {
    return items.map(item => ({
        id: 'gachaId' in item ? item.gachaId : item.eventId,
        name: item.name,
        imagePath: item.imagePath,
        imageCacheKey: item.imageCacheKey
    }));
}

/**
 * 画标题 + 卡片网格。
 * @param server 取图优先区域(跨区域回退由 eventAssetImage 负责)
 * @returns 网格底边 y
 */
export async function drawRelatedSection(
    ctx: Ctx, x: number, y: number, width: number,
    title: string, items: RelatedItem[], server: Server
): Promise<number> {
    if (items.length === 0) return y;
    const { perRow, tileW, imageH, tileH } = relatedLayout(width);
    const top = drawSectionTitle(ctx, x, y, `${title}（${items.length}）`, { fontSize: 15 }) + TITLE_GAP;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const tx = x + (i % perRow) * (tileW + GAP);
        const ty = top + Math.floor(i / perRow) * (tileH + GAP);

        ctx.fillStyle = '#222';
        ctx.fillRect(tx, ty, tileW, imageH);
        const img = await eventAssetImage(server, item.imagePath, item.imageCacheKey);
        if (img) drawFit(ctx, img, tx, ty, tileW, imageH);
        drawCornerIdBadge(ctx, tx, ty, tileW, imageH, item.id);
    }

    // 复位: 徽章把对齐方式改成了居中, 后续区块复用同一个 ctx
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    return top + Math.ceil(items.length / perRow) * (tileH + GAP);
}
