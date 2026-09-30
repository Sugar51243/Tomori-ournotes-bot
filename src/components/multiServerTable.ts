import { SKRSContext2D } from '@napi-rs/canvas';
import { ServerRow } from '../data/serverInfo';
import { serverProfile } from '../types/Server';
import { drawServerIcon } from './serverIcon';
import { cjkFontFamily } from './fonts';
import { fillTextCentered } from './draw';

/**
 * 「一行一服」的多服务器信息表: 行首是服国旗, 其后是该服各列的值。
 *
 * 列定义由调用方给出(通常取自第一行的 cells 标签), 这样歌表(定数/物量/上架)与
 * 详情页(稀有度/实装/综合力)可以共用同一套排版。
 */

const ROW_H = 26;
/** 图标边长: 与 13px 的 CJK 文字体量相当(16 会明显比文字高一截, 看起来像没对齐) */
const ICON = 14;

export interface MultiServerTableOptions {
    /** 首列(服名)宽度 */
    nameWidth?: number;
    /** 每列宽度; 缺省按剩余宽度均分 */
    columnWidth?: number;
    fontSize?: number;
    /** 表头文字颜色 */
    headerColor?: string;
    /** 是否画列头(默认画); 歌表这类「列头只在页首出现一次」的场景传 false */
    showHeader?: boolean;
    /** 只画列头不画数据行; 此时需用 labels 指定列名 */
    headerOnly?: boolean;
    /** 显式指定列名(headerOnly 或行数与列数不一致时使用) */
    labels?: string[];
}

/** 取一组行共同的列标签(以第一条存在的行为准) */
export function columnLabels(rows: ServerRow[]): string[] {
    const first = rows.find(r => r.exists);
    return first ? first.cells.map(([label]) => label) : [];
}

/**
 * 绘制多服务器表(含表头), 返回下一行的 y。
 * 某服不存在时该行显示「未收录」, 列位置仍然对齐。
 */
export async function drawMultiServerTable(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    width: number,
    rows: ServerRow[],
    options: MultiServerTableOptions = {}
): Promise<number> {
    if (rows.length === 0 && !options.headerOnly) return y;
    const { nameWidth = 96, fontSize = 13, headerColor = '#9aa4b2', showHeader = true } = options;
    const labels = options.labels ?? columnLabels(rows);
    const dataX = x + nameWidth;
    const dataW = width - nameWidth;
    const colW = options.columnWidth ?? (labels.length ? dataW / labels.length : dataW);

    // 表头
    if (showHeader || options.headerOnly) {
        ctx.font = cjkFontFamily(fontSize - 1);
        ctx.fillStyle = headerColor;
        for (let i = 0; i < labels.length; i++) {
            fillTextCentered(ctx, labels[i], dataX + i * colW + 4, y + ROW_H / 2, colW - 8);
        }
        y += ROW_H - 4;
    }
    if (options.headerOnly) return y;

    for (const row of rows) {
        const profile = serverProfile(row.server);
        // 行底色: 未收录的服压暗, 便于一眼区分
        ctx.fillStyle = row.exists ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.28)';
        ctx.fillRect(x, y, width, ROW_H - 2);

        // 图标与文字取同一个中心: 先按字形量出服名的光学中心, 再把图标对齐到它,
        // 避免 CJK 的 em 盒居中偏低导致"图标与名称没对齐"
        // 图标与文字都以 rowMidY 为「元素中心」:
        // 圆形的几何中心即视觉中心, 所以直接让它居中到 rowMidY;
        // 文字交给 fillTextCentered, 它会把字形的**光学中心**也摆到 rowMidY。
        // 注意不要把图标对到文字的基线上 —— 那会比光学中心低约 (ascent-descent)/2, 看起来像贴着底部。
        const rowMidY = y + (ROW_H - 2) / 2;
        await drawServerIcon(ctx, x + 6, rowMidY - ICON / 2, row.server, ICON);

        ctx.font = cjkFontFamily(fontSize);
        ctx.fillStyle = row.exists ? '#FFF' : '#8a93a0';
        fillTextCentered(ctx, profile.displayName, x + 6 + ICON + 6, rowMidY, nameWidth - ICON - 18);

        if (!row.exists) {
            ctx.fillStyle = '#8a93a0';
            fillTextCentered(ctx, '未收录', dataX + 4, rowMidY, dataW - 8);
        } else {
            ctx.fillStyle = '#DDD';
            for (let i = 0; i < row.cells.length; i++) {
                fillTextCentered(ctx, row.cells[i][1], dataX + i * colW + 4, rowMidY, colW - 8);
            }
        }
        y += ROW_H;
    }
    return y;
}

/** 高度预估(供先量后排的视图使用); showHeader=false 时不把列头算进去 */
export function multiServerTableHeight(rowCount: number, showHeader = true): number {
    if (rowCount <= 0 && !showHeader) return 0;
    const header = showHeader ? ROW_H - 4 : 0;
    return header + Math.max(rowCount, 0) * ROW_H;
}
