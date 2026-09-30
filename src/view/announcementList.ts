import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { imageBuffer } from '../data/assets';
import { isAllowedExternalImage } from '../data/externalImage';
import { Server, serverProfile } from '../types/Server';
import { Announcement, categoryMeta, formatAnnouncementTime } from '../types/Announcement';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../components/list';
import { drawBackground } from '../components/background';
import { drawServerIcon } from '../components/serverIcon';
import { wrapTextLines } from '../components/draw';
import { cjkFontFamily } from '../components/fonts';
import { fillTextCentered } from '../components/draw';

/**
 * 公告列表图(**单服一图**)。
 * 各服的公告内容完全不同、彼此没有对应实体, 不适合「同一实体多服对比」的多服单图,
 * 所以这里只画一个服, 区块头 = 国旗 + 服名 + 公告数。
 *
 * JP 的公告没有 bannerUrl(上游只有 stylesheetId), 此时退化为纯文字行。
 */

const WIDTH = 900;
const MARGIN = 16;
/** 页头 = 主标题带 + 副信息带(国旗 + 服名) */
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const BANNER_W = 104;
const BANNER_H = 52;
const ROW_WITH_BANNER = BANNER_H + 12;
/**
 * 无横幅时的行高。必须容得下「徽章(20) + 间距 + 标题(约 20)」——
 * 之前给 46, 标题下半截被卡片下边缘裁掉、还会顶到下一行。
 */
const ROW_TEXT_ONLY = 64;

const CJK = cjkFontFamily(15);

/** 分类徽章 */
function drawBadge(ctx: SKRSContext2D, x: number, y: number, category: string): number {
    const meta = categoryMeta(category);
    ctx.font = cjkFontFamily(12);
    const w = ctx.measureText(meta.label).width + 16;
    ctx.fillStyle = meta.color;
    ctx.fillRect(x, y, w, 20);
    ctx.fillStyle = '#FFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.label, x + 8, y + 11);
    return x + w + 8;
}

export async function drawAnnouncementList(server: Server, announcements: Announcement[], compress: boolean): Promise<Array<Buffer | string>> {
    if (announcements.length === 0) {
        return ['该服务器暂无公告'];
    }
    const profile = serverProfile(server);
    // 有可用横幅才用高行, 否则整表压扁(JP 全部无横幅)
    const usable = new Map<string, string>();
    for (const a of announcements) {
        // 有些公告只有 pickupBannerUrl; 两者都要过外链白名单
        const url = [a.bannerUrl, a.pickupBannerUrl].find(u => u && isAllowedExternalImage(u));
        if (url) usable.set(a.id, url);
    }
    const withBanner = usable.size > 0;
    const rowH = withBanner ? ROW_WITH_BANNER : ROW_TEXT_ONLY;

    const height = HEADER_H + MARGIN + announcements.length * rowH + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, `游戏公告（${announcements.length}）`);

    // 区块头: 国旗 + 服名(同在副信息带内, 与图标共用一个视觉中心)
    const metaMidY = drawMetaBand(ctx, WIDTH);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = CJK;
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 200);

    let y = HEADER_H + MARGIN;
    for (const a of announcements) {
        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, rowH - 6);

        let textX = MARGIN + 10;
        if (withBanner) {
            const url = usable.get(a.id);
            if (url) {
                const buf = await imageBuffer(url, `images/announcement/${server}/${a.id}.img`).catch(() => undefined);
                let drawn = false;
                if (buf) {
                    try {
                        ctx.drawImage(await loadImage(buf), textX, y + 6, BANNER_W, BANNER_H);
                        drawn = true;
                    } catch { /* 当作无图 */ }
                }
                // 拿不到图就不留黑框, 否则看起来像加载失败
                if (!drawn) {
                    ctx.fillStyle = '#222';
                    ctx.fillRect(textX, y + 6, BANNER_W, BANNER_H);
                }
            }
            textX += BANNER_W + 12;
        }

        const textW = WIDTH - MARGIN - 10 - textX;
        let ty = y + 10;
        const afterBadge = drawBadge(ctx, textX, ty, a.category);
        ctx.font = '12px "Arial"';
        ctx.fillStyle = '#8a93a0';
        ctx.textBaseline = 'middle';
        const time = `${formatAnnouncementTime(a.startAt, profile.utcOffsetMinutes)} ~ ${formatAnnouncementTime(a.endAt, profile.utcOffsetMinutes)}`;
        ctx.fillText(time, afterBadge, ty + 11, textX + textW - afterBadge);

        ty += 28;
        ctx.font = CJK;
        ctx.fillStyle = '#FFF';
        ctx.textBaseline = 'top';
        const lines = wrapTextLines(ctx, a.title, textW, withBanner ? 2 : 1);
        for (const line of lines) {
            ctx.fillText(line, textX, ty, textW);
            ty += 20;
        }

        y += rowH;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
