import { SKRSContext2D } from '@napi-rs/canvas';
import { drawSectionTitle, SECTION_TITLE_H } from '../components/list';
import { roundedRectPath } from '../components/draw';
import { FONT_STACK } from '../components/fonts';

/**
 * 详情图的「关键词」栏位: 把用户上传的关键词排成 chip 流式布局, 放不下换行。
 *
 * 与 relatedSection 不同, 这里的 chip 里没有图片, 所以**同一套 `layoutKeywordChips`
 * 同时供量高与绘制使用**, 两趟天然一致(只要 ctx 的字体状态相同, 两趟都用本模块设的字体)。
 *
 * 不做行数截断: 单实体的关键词已在入库时按 MAX_KEYWORDS_PER_ENTITY 限死, 行数有上界。
 * 关键词为空时整个栏位不占高度, 调用方据此跳过。
 */

const CHIP_H = 24;
const CHIP_GAP = 8;
const CHIP_PAD_X = 10;
const ROW_GAP = 8;
const TITLE_GAP = 6;
const FONT = `13px ${FONT_STACK}`;

type Ctx = SKRSContext2D;

interface Chip { text: string; w: number }

/** 流式排布(量高与绘制共用) */
function layoutKeywordChips(ctx: Ctx, keywords: string[], width: number): Chip[][] {
    ctx.font = FONT;
    const rows: Chip[][] = [];
    let row: Chip[] = [];
    let used = 0;
    for (const text of keywords) {
        const w = Math.min(width, Math.ceil(ctx.measureText(text).width) + CHIP_PAD_X * 2);
        if (row.length > 0 && used + CHIP_GAP + w > width) {
            rows.push(row);
            row = [];
            used = 0;
        }
        row.push({ text, w });
        used = row.length === 1 ? w : used + CHIP_GAP + w;
    }
    if (row.length > 0) rows.push(row);
    return rows;
}

function layoutHeight(rows: Chip[][]): number {
    return rows.length * CHIP_H + Math.max(0, rows.length - 1) * ROW_GAP;
}

/** 栏位占用的总高度(标题行 + chip 行); keywords 为空时为 0 */
export function keywordSectionHeight(ctx: Ctx, keywords: string[], width: number): number {
    if (keywords.length === 0) return 0;
    return SECTION_TITLE_H + TITLE_GAP + layoutHeight(layoutKeywordChips(ctx, keywords, width));
}

/** 画标题 + chip 网格; 返回栏位底边 y(关键词为空时原样返回 y) */
export function drawKeywordSection(ctx: Ctx, x: number, y: number, width: number, keywords: string[]): number {
    if (keywords.length === 0) return y;
    const rows = layoutKeywordChips(ctx, keywords, width);
    let cy = drawSectionTitle(ctx, x, y, `关键词（${keywords.length}）`, { fontSize: 15 }) + TITLE_GAP;

    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const row of rows) {
        let cx = x;
        for (const chip of row) {
            ctx.fillStyle = 'rgba(58, 95, 168, 0.55)';
            roundedRectPath(ctx, cx, cy, chip.w, CHIP_H, CHIP_H / 2);
            ctx.fill();
            ctx.fillStyle = '#FFF';
            ctx.fillText(chip.text, cx + CHIP_PAD_X, cy + CHIP_H / 2, chip.w - CHIP_PAD_X * 2);
            cx += chip.w + CHIP_GAP;
        }
        cy += CHIP_H + ROW_GAP;
    }

    // 复位: 后续区块复用同一个 ctx
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // 直接用这一趟的 rows 算高度, 与 keywordSectionHeight 的公式同源
    return y + SECTION_TITLE_H + TITLE_GAP + layoutHeight(rows);
}
