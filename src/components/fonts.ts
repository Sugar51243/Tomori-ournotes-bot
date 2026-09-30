import { GlobalFonts } from '@napi-rs/canvas';
import * as fs from 'fs';
import { logger } from '../logger';

/**
 * 注册 Windows 字体: 主字体(中文) + 符号/表情回退字体。
 * canvas 不支持 CSS 那样的逐字回退, 但已注册的字体会被 Skia 用作缺字回退,
 * 前提是它们出现在 font 的字体族列表里(见 FONT_STACK)。
 */
const CJK_FONTS = [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyh.ttf',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/arial.ttf'
];
/**
 * 韩文回退: 上面这些字体都不含谚文, 而**公告标题是上游原文**(不走 MasterText),
 * 韩服公告会整篇变豆腐块。Malgun Gothic 是 Windows 自带的韩文字体。
 */
const KOREAN_FONTS = [
    'C:/Windows/Fonts/malgun.ttf',
    'C:/Windows/Fonts/gulim.ttc',
    'C:/Windows/Fonts/batang.ttc'
];
/** 符号/表情回退: Segoe UI Symbol 覆盖炼金术符号(歌曲 Symbol II/IV 🜁🜃)、♡、emoji 等微软雅黑缺字 */
const SYMBOL_FONTS = [
    'C:/Windows/Fonts/seguisym.ttf',
    'C:/Windows/Fonts/seguiemj.ttf'
];

/** 统一字体栈: 主字体缺字时依次由后面的族补上(故 Segoe UI Symbol 必须排在 Arial 之前) */
export const FONT_STACK = '"Microsoft YaHei", "Malgun Gothic", "Segoe UI Symbol", "Segoe UI Emoji", "SimHei", "Arial", sans-serif';

export function registerFonts(): void {
    let registered = false;
    for (const p of CJK_FONTS) {
        try {
            if (fs.existsSync(p)) {
                GlobalFonts.registerFromPath(p);
                logger('fonts', `registered font: ${p}`);
                registered = true;
                break;
            }
        } catch {
            /* 尝试下一个 */
        }
    }
    if (!registered) {
        logger('fonts', 'warning: no CJK font registered, Chinese text may not render');
    }
    for (const p of KOREAN_FONTS) {
        try {
            if (fs.existsSync(p)) {
                GlobalFonts.registerFromPath(p);
                logger('fonts', `registered korean font: ${p}`);
                break;
            }
        } catch {
            /* 尝试下一个 */
        }
    }
    for (const p of SYMBOL_FONTS) {
        try {
            if (fs.existsSync(p)) {
                GlobalFonts.registerFromPath(p);
                logger('fonts', `registered fallback font: ${p}`);
            }
        } catch {
            /* 缺字时退回豆腐块 */
        }
    }
}

/** 统一字体栈(带字号) */
export function cjkFontFamily(sizePx: number): string {
    return `${sizePx}px ${FONT_STACK}`;
}
