import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { imageBuffer } from '../data/assets';
import { isAllowedExternalImage } from '../data/externalImage';
import { Server, serverProfile } from '../types/Server';
import { Announcement, categoryMeta, formatAnnouncementTime } from '../types/Announcement';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { drawServerIcon } from '../components/serverIcon';
import { FONT_STACK, cjkFontFamily } from '../components/fonts';

/**
 * 单条公告详情图(一次性接口传 id 时使用)。
 *
 * 上游的 body 是**完整 HTML 文档**(游戏 WebView 直接渲染), 这里不做 HTML 渲染 ——
 * 去掉 style/script 与标签后当纯文本排版, 让「公告内容」真的看得见。
 */

const WIDTH = 900;
const MARGIN = 16;
const HEADER_H = 56;
const BANNER_H = 180;
const LINE_H = 21;
const LINES_PER_PAGE = 42;
/** 元信息条(国旗/服名/分类/时间)的高度 */
const META_H = 32;
/** 元信息条与标题之间、标题与正文之间的间距 */
const TITLE_GAP = 14;
const TITLE_H = 30;
/** 正文行数上限: 极端长的公告不至于出成几十页 */
const MAX_LINES = 400;

/** 注意: 这是纯字体族栈(不含字号), 需要别的字号时写成 `bold 20px ${FONT_STACK}`;
 * 若用 cjkFontFamily(15) 再拼 "bold 20px ...", 会得到 "bold 20px 15px ..." 这种非法字体串,
 * canvas 会回退到无中文字形的默认字体, 中文全变豆腐块。 */
const CJK = cjkFontFamily(15);

const ENTITIES: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"
};

/** HTML 公告正文 -> 纯文本行 */
export function htmlToLines(html: string): string[] {
    const text = html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m.toLowerCase()] ?? ' ')
        .replace(/\r/g, '');

    const lines: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/[ \t　]+/g, ' ').trim();
        if (line) lines.push(line);
    }
    return lines.slice(0, MAX_LINES);
}

/** 按宽度折行(逐字符, 兼容 CJK 与长 URL) */
function wrap(ctx: SKRSContext2D, lines: string[], maxWidth: number): string[] {
    const out: string[] = [];
    for (const line of lines) {
        let current = '';
        for (const ch of line) {
            if (ctx.measureText(current + ch).width > maxWidth && current) {
                out.push(current);
                current = ch;
            } else {
                current += ch;
            }
        }
        if (current) out.push(current);
    }
    return out;
}

export async function drawAnnouncementDetail(server: Server, item: Announcement, compress: boolean): Promise<Array<Buffer | string>> {
    const profile = serverProfile(server);
    const meta = categoryMeta(item.category);

    // 先量后画: 正文折行结果决定画布高度与页数
    const measureCanvas = createCanvas(WIDTH, 10);
    const mctx = measureCanvas.getContext('2d');
    mctx.font = CJK;
    const bodyLines = wrap(mctx, htmlToLines(item.body ?? ''), WIDTH - MARGIN * 2);
    const pages: string[][] = [];
    for (let i = 0; i < Math.max(bodyLines.length, 1); i += LINES_PER_PAGE) {
        pages.push(bodyLines.slice(i, i + LINES_PER_PAGE));
    }

    const timeRange = `${formatAnnouncementTime(item.startAt, profile.utcOffsetMinutes)} ~ ${formatAnnouncementTime(item.endAt, profile.utcOffsetMinutes)}`;
    const hasBanner = !!item.bannerUrl && isAllowedExternalImage(item.bannerUrl);

    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        // 高度按该页实际行数算: 正文短时不至于留下大片空白
        const bodyH = Math.max(pages[p].length, 1) * LINE_H;
        const height = HEADER_H + META_H + TITLE_GAP + TITLE_H
            + (hasBanner ? BANNER_H + 12 : 0) + 28 + bodyH + MARGIN;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');

        await drawBackground(ctx, WIDTH, height, { server });
        const pageLabel = pages.length > 1 ? `（第 ${p + 1}/${pages.length} 页）` : '';
        drawTitle(ctx, WIDTH, `公告详情${pageLabel}`);

        // 元信息压一条深色底, 保证在任意背景图上都可读
        ctx.fillStyle = 'rgba(24, 26, 44, 0.82)';
        ctx.fillRect(0, HEADER_H, WIDTH, META_H);

        // 国旗 + 服名 + 分类徽章
        await drawServerIcon(ctx, MARGIN, HEADER_H + 8, server, 16);
        ctx.textBaseline = 'middle';
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#DDD';
        ctx.fillText(profile.displayName, MARGIN + 26, HEADER_H + 16);
        // 依次按实测宽度排布, 避免服名与徽章重叠
        let hx = MARGIN + 26 + ctx.measureText(profile.displayName).width + 14;

        ctx.font = cjkFontFamily(12);
        const badgeW = ctx.measureText(meta.label).width + 16;
        ctx.fillStyle = meta.color;
        ctx.fillRect(hx, HEADER_H + 6, badgeW, 20);
        ctx.fillStyle = '#FFF';
        ctx.fillText(meta.label, hx + 8, HEADER_H + 17);
        hx += badgeW + 10;

        ctx.font = '12px "Arial"';
        ctx.fillStyle = '#8a93a0';
        ctx.fillText(`#${item.id}`, hx, HEADER_H + 16, 70);
        ctx.fillText(timeRange, WIDTH - MARGIN - 260, HEADER_H + 16, 260);

        // 标题(排在元信息条下方, 不与它重叠)
        let y = HEADER_H + META_H + TITLE_GAP;
        ctx.font = `bold 20px ${FONT_STACK}`;
        ctx.fillStyle = '#FFF';
        ctx.textBaseline = 'top';
        ctx.fillText(item.title, MARGIN, y, WIDTH - MARGIN * 2);
        y += TITLE_H;

        // 横幅(JP 没有该字段, 自动跳过)
        if (hasBanner && item.bannerUrl) {
            const buf = await imageBuffer(item.bannerUrl, `images/announcement/${server}/detail_${item.id}.img`).catch(() => undefined);
            if (buf) {
                try {
                    const img = await loadImage(buf);
                    const scale = Math.min((WIDTH - MARGIN * 2) / img.width, BANNER_H / img.height);
                    const dw = img.width * scale, dh = img.height * scale;
                    ctx.drawImage(img, MARGIN, y, dw, dh);
                    y += BANNER_H + 12;
                } catch { y += 12; }
            }
        } else {
            y += 12;
        }

        // 正文
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(MARGIN, y);
        ctx.lineTo(WIDTH - MARGIN, y);
        ctx.stroke();
        y += 10;

        ctx.font = CJK;
        ctx.fillStyle = '#DDE3EC';
        const pageLines = pages[p];
        if (pageLines.length === 0) {
            ctx.fillStyle = '#8a93a0';
            ctx.fillText('（该公告没有正文）', MARGIN, y);
        }
        for (const line of pageLines) {
            ctx.fillText(line, MARGIN, y, WIDTH - MARGIN * 2);
            y += LINE_H;
        }

        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
