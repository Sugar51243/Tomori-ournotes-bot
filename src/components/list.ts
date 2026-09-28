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

/** 页头横幅(半透明, 以便透出背景图) */
export function drawTitle(ctx: SKRSContext2D, width: number, text: string, color = 'rgba(24, 26, 44, 0.82)'): void {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, 48);
    ctx.fillStyle = '#FFF';
    ctx.font = `22px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, 24, width - 32);
}

/** 最终输出(tsugu outputFinalBuffer 简化版) */
export async function outputFinalBuffer(canvas: Canvas, compress: boolean): Promise<Buffer> {
    return compress ? await canvas.encode('jpeg', 70) : await canvas.encode('png');
}
