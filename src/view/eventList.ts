import { createCanvas } from '@napi-rs/canvas';
import { Event } from '../types/Event';
import { Server } from '../types/Server';
import { drawTitle, outputFinalBuffer, TITLE_BAND_H } from '../components/list';
import { drawBackground, commonBandId } from '../components/background';
import { fillTextCentered, formatDateTime } from '../components/draw';
import { cjkFontFamily } from '../components/fonts';
import { eventArtImage } from './eventArt';

/**
 * 活动搜索**列表图**(命中多个活动时用)。
 * 一行一个活动: 活动图标 + 活动 ID + 活动名称 + 起止时间 + 相关乐团。
 * 命中只有一个活动时不出这张图, 直接出活动丰富详情(见 searchEvent.ts)。
 */

const WIDTH = 820;
const MARGIN = 14;
const ROW_H = 96;
/** 活动图标：上游 logo 是 460x240(约 1.92:1), 等比放进这个框 */
const LOGO_W = 112;
const LOGO_H = 58;

export async function drawEventList(server: Server, events: Event[], compress: boolean): Promise<Array<Buffer | string>> {
    const height = TITLE_BAND_H + MARGIN + events.length * ROW_H + MARGIN;
    const width = WIDTH;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 结果全部同属一个乐队时用该乐队背景, 混合结果用通用背景(与歌曲列表同规则)
    await drawBackground(ctx, width, height, { server, bandId: commonBandId(events.flatMap(e => e.bonusBandIds)) });
    drawTitle(ctx, width, `共 ${events.length} 个活动`);

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const y = TITLE_BAND_H + MARGIN + i * ROW_H;

        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(MARGIN, y, width - MARGIN * 2, ROW_H - 8);

        // 活动图标: 先铺占位块, 取不到就保持占位; 有图则等比缩放后居中(不拉伸)
        const logoX = MARGIN + 8;
        const logoY = y + (ROW_H - 8 - LOGO_H) / 2;
        ctx.fillStyle = '#222';
        ctx.fillRect(logoX, logoY, LOGO_W, LOGO_H);
        const logo = await eventArtImage(event, 'logo');
        if (logo) {
            const scale = Math.min(LOGO_W / logo.width, LOGO_H / logo.height);
            const w = logo.width * scale;
            const h = logo.height * scale;
            ctx.drawImage(logo, logoX + (LOGO_W - w) / 2, logoY + (LOGO_H - h) / 2, w, h);
        }

        const tx = logoX + LOGO_W + 12;
        const maxW = MARGIN + width - MARGIN - tx;

        // 第一行: 活动 ID + 名称
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 14px "Arial"';
        ctx.fillStyle = '#7ec8ff';
        const idText = `ID ${event.eventId}`;
        ctx.fillText(idText, tx, y + 20);
        const idW = ctx.measureText(idText).width;
        ctx.font = cjkFontFamily(17);
        ctx.fillStyle = '#FFF';
        ctx.fillText(event.eventName || '(无名称)', tx + idW + 10, y + 20, maxW - idW - 10);

        // 第二行: 起止时间
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#DDD';
        ctx.fillText(`${formatDateTime(event.startAt)} ~ ${formatDateTime(event.endAt)}`, tx, y + 46, maxW);

        // 第三行: 相关乐团
        if (event.bonusBandNames.length) {
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText(`乐团：${event.bonusBandNames.join(' / ')}`, tx, y + 70, maxW);
        }
    }

    return [await outputFinalBuffer(canvas, compress)];
}
