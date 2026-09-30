import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { cardFullArtUrl, imageBuffer, assetCacheKey } from '../data/assets';
import { isAllowedExternalImage } from '../data/externalImage';
import { Server, serverProfile } from '../types/Server';
import { PlayerProfile } from '../types/Player';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../components/list';
import { drawServerIcon } from '../components/serverIcon';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK, cjkFontFamily } from '../components/fonts';
import { fillTextCentered } from '../components/draw';

/**
 * 玩家档案图(**单服一图**)。
 *
 * 视觉主体用「最爱成员卡」的卡面大图 —— 该字段四个服都有, 且取自**本项目自己的素材源**,
 * 不依赖玩家自己上传的 profile card(港澳台服常为空)。
 * profile card 缩略图来自游戏 CDN, 需过外链白名单, 有就附在下方。
 */

const WIDTH = 720;
/** 页头 = 主标题带 + 副信息带(国旗/服名/ID), 卡面大图从页头下方开始 */
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const ART_H = 320;
const MARGIN = 16;

/** 卡面大图铺满顶部并压暗, 保证文字可读 */
async function drawArt(ctx: SKRSContext2D, server: Server, cardId: number | undefined, height: number): Promise<void> {
    ctx.fillStyle = '#141824';
    ctx.fillRect(0, HEADER_H, WIDTH, height);
    if (!cardId) return;
    const url = cardFullArtUrl(server, cardId);
    const buf = await imageBuffer(url, assetCacheKey(server, `card/${cardId}_full_player.webp`)).catch(() => undefined);
    if (!buf) return;
    try {
        const img = await loadImage(buf);
        const scale = Math.max(WIDTH / img.width, height / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, HEADER_H, WIDTH, height);
        ctx.clip();
        ctx.drawImage(img, (WIDTH - dw) / 2, HEADER_H + (height - dh) / 2, dw, dh);
        ctx.restore();
    } catch {
        /* 保持底色 */
    }
    const grd = ctx.createLinearGradient(0, HEADER_H, 0, HEADER_H + height);
    grd.addColorStop(0, 'rgba(8,10,20,0.45)');
    grd.addColorStop(1, 'rgba(8,10,20,0.88)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, HEADER_H, WIDTH, height);
}

function drawStat(ctx: SKRSContext2D, x: number, y: number, label: string, value: string): void {
    ctx.textBaseline = 'top';
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(label, x, y);
    ctx.font = `bold 20px ${FONT_STACK}`;
    ctx.fillStyle = '#FFF';
    ctx.fillText(value, x, y + 18, 200);
}

export async function drawPlayerProfile(server: Server, profile: PlayerProfile, compress: boolean): Promise<Array<Buffer | string>> {
    const p = serverProfile(server);
    // profile card 缩略图(比例 1224:688), 只保留通过白名单的
    const cardUrls = profile.profileCardUrls.filter(isAllowedExternalImage).slice(0, 3);
    const cardH = cardUrls.length ? Math.round((WIDTH - MARGIN * 2) / (1224 / 688)) + 12 : 0;
    const HEIGHT = HEADER_H + ART_H + cardH + MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0d16';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    await drawArt(ctx, server, profile.favoriteCardId, ART_H);
    drawTitle(ctx, WIDTH, '账号查询');

    // 顶部: 国旗 + 服名 + ID(同在副信息带内, 与图标共用一个视觉中心)
    const metaMidY = drawMetaBand(ctx, WIDTH);
    await drawServerIcon(ctx, MARGIN, metaMidY - 9, server, 18);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, p.displayName, MARGIN + 30, metaMidY, 200);
    ctx.font = '13px "Arial"';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right';
    fillTextCentered(ctx, `ID ${profile.profileId}`, WIDTH - MARGIN, metaMidY);
    ctx.textAlign = 'left';

    // 玩家名
    let y = HEADER_H + 52;
    ctx.font = `bold 30px ${FONT_STACK}`;
    ctx.fillStyle = '#FFF';
    ctx.textBaseline = 'top';
    const name = profile.name || '(未公开名称)';
    for (const line of wrapTextLines(ctx, name, WIDTH - MARGIN * 2, 2)) {
        ctx.fillText(line, MARGIN, y, WIDTH - MARGIN * 2);
        y += 38;
    }

    // 统计块
    const statY = HEADER_H + ART_H - 76;
    const statX = [MARGIN, MARGIN + 180, MARGIN + 360];
    drawStat(ctx, statX[0], statY, '等级', profile.level !== undefined ? `Lv.${profile.level}` : '-');
    drawStat(ctx, statX[1], statY, '应援数', profile.totalFavorite !== undefined ? String(profile.totalFavorite) : '-');
    drawStat(ctx, statX[2], statY, '经验', profile.rankExp ?? '-');

    // 玩家自制 profile card
    if (cardUrls.length) {
        let cy = HEADER_H + ART_H + 8;
        for (const url of cardUrls) {
            const buf = await imageBuffer(url, `images/playercard/${server}/${profile.profileId}_${cy}.img`).catch(() => undefined);
            if (!buf) continue;
            try {
                ctx.drawImage(await loadImage(buf), MARGIN, cy, WIDTH - MARGIN * 2, cardH - 12);
                cy += cardH;
            } catch { /* 跳过 */ }
        }
    }

    return [await outputFinalBuffer(canvas, compress)];
}
