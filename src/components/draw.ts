import { SKRSContext2D } from '@napi-rs/canvas';

/**
 * 以**字形实际上下界**在 centerY 处做视觉居中。
 * CJK 字体的 em 盒比字形本身高, 直接用 textBaseline='middle' 会整体偏低,
 * 与旁边的图标/色块排在一行时看得出来。
 * 调用前请自备 ctx.font 与 ctx.fillStyle(本函数只动 textBaseline)。
 */
export function fillTextCentered(ctx: SKRSContext2D, text: string, x: number, centerY: number, maxWidth?: number): void {
    const prev = ctx.textBaseline;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text);
    const baseline = centerY + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.fillText(text, x, baseline, maxWidth);
    ctx.textBaseline = prev;
}

/** 圆角矩形路径 */
export function roundedRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

/**
 * 清洗渲染文本: 统一换行为 \n 并去掉其余控制字符。
 * master 文案里描述常带 \r\n, 而 canvas 会把 \r 当成缺字渲染成豆腐块。
 */
export function cleanText(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
}

/** 文本按最大宽度换行(逐字符折行, CJK 安全; 显式换行按段落处理; 西文尽量不在词中折断) */
export function wrapTextLines(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines = 2): string[] {
    if (!text) return [];
    const all: string[] = [];
    for (const paragraph of cleanText(text).split('\n')) {
        let current = '';
        for (const ch of paragraph) {
            if (ctx.measureText(current + ch).width > maxWidth && current.length > 0) {
                // 折行处两侧都是西文(字母/数字/括号)时, 回退到最近的空格断开,
                // 否则会把 "長谷川大介(SUPA LOVE)" 劈成 "...SUPA LOV" + "E)"
                let head = current;
                let rest = ch;
                if (/[0-9A-Za-z)\]]/.test(current[current.length - 1]) && /[0-9A-Za-z(]/.test(ch)) {
                    const sp = current.lastIndexOf(' ');
                    if (sp > 0 && current.length - sp <= 24) {
                        head = current.slice(0, sp);
                        rest = current.slice(sp + 1) + ch;
                    }
                }
                all.push(head);
                current = rest;
            } else {
                current += ch;
            }
        }
        if (current) all.push(current);
    }
    if (all.length <= maxLines) return all;
    const kept = all.slice(0, maxLines);
    // 截断提示
    const last = kept[maxLines - 1];
    if (last.length > 1) kept[maxLines - 1] = last.slice(0, last.length - 1) + '…';
    return kept;
}

/** 根据 y 位置调整文字基线, 避免贴边被裁切 */
export function adaptText(ctx: SKRSContext2D, fontSize: number, y: number, height: number): void {
    if (y <= fontSize / 2) ctx.textBaseline = 'top';
    else if (y >= height - fontSize / 2) ctx.textBaseline = 'bottom';
    else ctx.textBaseline = 'middle';
}

/** 播放时间 mm:ss */
export function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}
