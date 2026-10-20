import { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { wrapTextLines } from './draw';
import { FONT_STACK } from './fonts';

/** 列表页通用绘图原语 */

export interface DrawBlockRow {
    key: string;
    text: string;
}

/** 单列数据块(tsugu drawDatablock 简化版) */
export function drawDatablock(ctx: SKRSContext2D, startX: number, startY: number, rows: DrawBlockRow[], width: number, options?: { keyColor?: string; textColor?: string; fontSize?: number }): number {
    const keyColor = options?.keyColor ?? '#BBB';
    const textColor = options?.textColor ?? '#FFF';
    const fontSize = options?.fontSize ?? 16;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let y = startY;
    for (const row of rows) {
        ctx.font = `${fontSize}px ${FONT_STACK}`;
        const keyW = ctx.measureText(row.key).width;
        ctx.fillStyle = keyColor;
        ctx.fillText(row.key, startX, y);
        ctx.fillStyle = textColor;
        const lines = wrapTextLines(ctx, row.text, width - keyW - 8, 3);
        for (const line of lines) {
            ctx.fillText(line, startX + keyW + 8, y);
            y += fontSize + 6;
        }
        // 空值也必须占一行高度, 否则后续行会重叠
        if (lines.length === 0) y += fontSize + 6;
        y += 4;
    }
    return y;
}

/** 区块标题(左侧 4px 竖条 + 粗体文字)的行高 */
export const SECTION_TITLE_H = 20;

/**
 * 区块标题: 各详情图里「技能 / 各服信息 / 难度」等小标题的统一画法
 * (cardList.ts、cardDetail.ts、songDetail.ts 等原先各写了一份同样的代码)。
 * @returns 标题块的底边 y(= y + SECTION_TITLE_H), 便于调用方接着往下排
 */
export function drawSectionTitle(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    text: string,
    options?: { color?: string; fontSize?: number }
): number {
    ctx.fillStyle = options?.color ?? '#3a5fa8';
    ctx.fillRect(x, y, 4, SECTION_TITLE_H);
    ctx.fillStyle = '#FFF';
    ctx.font = `bold ${options?.fontSize ?? 17}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 14, y + SECTION_TITLE_H / 2);
    return y + SECTION_TITLE_H;
}

/** 分区标题带高度(通铺底色 + 左侧竖条) */
export const SECTION_BAND_H = 26;

/**
 * 分区标题带: 通铺底色 + 左侧竖条, 让出图的分区一眼能分开(活动详情/活动榜线共用)。
 * @returns 分区内容的起始 y(= y + SECTION_BAND_H + 6)
 */
export function drawSectionBand(ctx: SKRSContext2D, width: number, y: number, title: string, margin = 16): number {
    ctx.fillStyle = 'rgba(58, 95, 168, 0.30)';
    ctx.fillRect(0, y, width, SECTION_BAND_H);
    ctx.fillStyle = '#5b8fe0';
    ctx.fillRect(margin, y + 4, 4, SECTION_BAND_H - 8);
    ctx.font = `bold 15px ${FONT_STACK}`;
    ctx.fillStyle = '#FFF';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(title, margin + 14, y + SECTION_BAND_H / 2, width - margin * 2 - 20);
    return y + SECTION_BAND_H + 6;
}

/** 页头主标题带高度 */
export const TITLE_BAND_H = 48;
/** 页头副信息带高度(服务器行/说明文字) */
export const META_BAND_H = 32;

/** 页头横幅(半透明, 以便透出背景图) */
export function drawTitle(ctx: SKRSContext2D, width: number, text: string, color = 'rgba(24, 26, 44, 0.82)'): void {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, TITLE_BAND_H);
    ctx.fillStyle = '#FFF';
    ctx.font = `22px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, TITLE_BAND_H / 2, width - 32);
}

/**
 * 副信息带的纯色底(紧贴主标题带下方)。
 * 副标题、服务器行这类内容必须画在这条带子内 —— 否则半截压在背景图上, 看起来既不属于标题栏也没对齐。
 * @returns 这条带子的垂直中线 y, 供调用方做居中绘制
 */
export function drawMetaBand(ctx: SKRSContext2D, width: number, color = 'rgba(24, 26, 44, 0.82)'): number {
    ctx.fillStyle = color;
    ctx.fillRect(0, TITLE_BAND_H, width, META_BAND_H);
    return TITLE_BAND_H + META_BAND_H / 2;
}

/** 最终输出(tsugu outputFinalBuffer 简化版) */
export async function outputFinalBuffer(canvas: Canvas, compress: boolean): Promise<Buffer> {
    return compress ? await canvas.encode('jpeg', 70) : await canvas.encode('png');
}
