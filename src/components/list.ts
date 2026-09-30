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
