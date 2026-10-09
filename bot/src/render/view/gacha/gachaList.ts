import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Gacha, formatGameDate, zoneLabel } from '../../../features/types/Gacha';
import { Server } from '../../../features/types/Server';
import { drawTitle, outputFinalBuffer, TITLE_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { cjkFontFamily } from '../../component/fonts';
import { imageBuffer, gachaBannerUrl } from '../../../upstream/adapter';

/**
 * 卡池搜索**列表图**(模糊搜索命中多个卡池时用)。
 * 一行一个卡池: 横幅缩略图 + 卡池 ID + 名称 + 起止时间(区域时区) + 状态标签。
 * 命中只有一个卡池时不出这张图, 直接出卡池详情(见 searchGacha.ts)。
 */

const WIDTH = 820;
const MARGIN = 14;
const ROW_H = 96;
/** 横幅上游约 420×180(约 2.33:1), 等比放进这个框 */
const BANNER_W = 128;
const BANNER_H = 55;

export async function drawGachaList(server: Server, gachas: Gacha[], compress: boolean): Promise<Array<Buffer | string>> {
    const height = TITLE_BAND_H + MARGIN + gachas.length * ROW_H + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, `共 ${gachas.length} 个卡池`);

    for (let i = 0; i < gachas.length; i++) {
        const gacha = gachas[i];
        const y = TITLE_BAND_H + MARGIN + i * ROW_H;

        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 8);

        // 横幅缩略图: 先铺占位块, 取不到就保持占位; 有图则等比缩放后居中(不拉伸)
        const bx = MARGIN + 8;
        const by = y + (ROW_H - 8 - BANNER_H) / 2;
        ctx.fillStyle = '#222';
        ctx.fillRect(bx, by, BANNER_W, BANNER_H);
        if (gacha.bannerAssetName) {
            const buf = await imageBuffer(
                gachaBannerUrl(server, gacha.bannerAssetName),
                `images/gacha/${server}/${gacha.gachaId}_banner.webp`
            ).catch(() => undefined);
            const banner = buf ? await loadImage(buf).catch(() => undefined) : undefined;
            if (banner) {
                const scale = Math.min(BANNER_W / banner.width, BANNER_H / banner.height);
                const w = banner.width * scale;
                const h = banner.height * scale;
                ctx.drawImage(banner, bx + (BANNER_W - w) / 2, by + (BANNER_H - h) / 2, w, h);
            }
        }

        const tx = bx + BANNER_W + 12;
        const maxW = WIDTH - MARGIN - tx;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        // 第一行: 卡池 ID + 名称
        ctx.font = 'bold 14px "Arial"';
        ctx.fillStyle = '#7ec8ff';
        const idText = `ID ${gacha.gachaId}`;
        ctx.fillText(idText, tx, y + 20);
        const idW = ctx.measureText(idText).width;
        ctx.font = cjkFontFamily(17);
        ctx.fillStyle = '#FFF';
        ctx.fillText(gacha.gachaName || '(无名称)', tx + idW + 10, y + 20, maxW - idW - 10);

        // 第二行: 起止时间
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#DDD';
        const period = `${gacha.startAt ? formatGameDate(gacha.startAt, server) : '-'} ~ ${gacha.endAt ? formatGameDate(gacha.endAt, server) : '-'}`;
        ctx.fillText(`${period} (${zoneLabel(server)})`, tx, y + 46, maxW);

        // 第三行: 状态标签
        const tags = [gacha.isOpen() ? '开放中' : '已结束'];
        if (gacha.isLimited) tags.push('限定');
        if (gacha.isNewMember) tags.push('新成员');
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(tags.join(' · '), tx, y + 70, maxW);
    }

    return [await outputFinalBuffer(canvas, compress)];
}
