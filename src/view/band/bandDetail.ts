import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Band } from '../../types/Band';
import { Server, serverProfile } from '../../types/Server';
import { ServerRow } from '../../data/serverInfo';
import { imageBuffer, bandLogoUrl, bandSmallIconUrl, assetCacheKey, characterIconUrl } from '../../data/assets';
import { drawTitle, drawMetaBand, drawSectionTitle, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../components/list';
import { drawMultiServerTable, multiServerTableHeight } from '../../components/multiServerTable';
import { drawBackground } from '../../components/background';
import { drawServerIcon } from '../../components/serverIcon';
import { fillTextCentered, wrapTextLines, cleanText, roundedRectPath } from '../../components/draw';
import { cjkFontFamily } from '../../components/fonts';

/**
 * 乐团详情 / 乐团列表出图。
 *
 * 内容: 乐团 ID、名称、图标、简介、应援色(主/副色), 以及成员(角色 id + 名称)。
 * 乐团属于**静态游戏数据**, 沿用多服一图的规则: 主体用「自己有该乐团」的服渲染, 下方附各服信息表。
 */

const WIDTH = 720;
const MARGIN = 16;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const LOGO = 120;
/** 成员格子 */
const MEMBER_CELL_W = 232;
const MEMBER_CELL_H = 46;
const MEMBER_COLUMNS = 3;

/**
 * 等比缩放居中放进框里(**不拉伸**): 乐团队标是横版(实测 214x85), 小图标是方形(62x62),
 * 直接按框宽高画会把它们拉变形。
 */
async function drawFit(ctx: SKRSContext2D, buf: Buffer | undefined, x: number, y: number, w: number, h: number): Promise<void> {
    if (!buf) return;
    try {
        const img = await loadImage(buf);
        const scale = Math.min(w / img.width, h / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } catch { /* 占位块保留 */ }
}

/** 应援色色块(主色 / 副色) */
function drawColorSwatch(ctx: SKRSContext2D, x: number, y: number, label: string, color: string): void {
    ctx.fillStyle = color;
    roundedRectPath(ctx, x, y, 28, 20, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, 27, 19);
    ctx.fillStyle = '#BBB';
    ctx.font = cjkFontFamily(13);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${color}`, x + 36, y + 10);
}

/** 成员网格: 头像 + 名称 + ID; 返回底部 y */
async function drawMembers(ctx: SKRSContext2D, server: Server, members: Band['members'], x: number, y: number): Promise<number> {
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const cx = x + (i % MEMBER_COLUMNS) * MEMBER_CELL_W;
        const cy = y + Math.floor(i / MEMBER_COLUMNS) * MEMBER_CELL_H;
        ctx.fillStyle = '#222';
        ctx.fillRect(cx, cy, 36, 36);
        const icon = await imageBuffer(characterIconUrl(server, m.id), assetCacheKey(server, `character/${m.id}_icon.webp`));
        if (icon) {
            try { ctx.drawImage(await loadImage(icon), cx, cy, 36, 36); } catch { /* 占位 */ }
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = cjkFontFamily(14);
        ctx.fillStyle = '#FFF';
        ctx.fillText(cleanText(m.name || `#${m.id}`), cx + 44, cy + 3, MEMBER_CELL_W - 50);
        ctx.font = '11px "Arial"';
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`ID ${m.id}`, cx + 44, cy + 22, MEMBER_CELL_W - 50);
    }
    const rows = Math.ceil(members.length / MEMBER_COLUMNS);
    return y + Math.max(1, rows) * MEMBER_CELL_H;
}

export async function drawBandDetail(band: Band, rows: ServerRow[], compress: boolean): Promise<Array<Buffer | string>> {
    const server = band.server;
    const descWidth = WIDTH - MARGIN * 2;
    const probe = createCanvas(10, 10).getContext('2d');
    probe.font = cjkFontFamily(14);
    const descLines = band.description ? wrapTextLines(probe, band.description, descWidth, 6) : [];
    const memberRows = Math.max(1, Math.ceil(band.members.length / MEMBER_COLUMNS));

    const tableH = rows.length ? multiServerTableHeight(rows.length) : 0;
    const height = HEADER_H + MARGIN
        + LOGO + 16
        + (descLines.length ? 26 + descLines.length * 20 + 8 : 0)
        + 26 + 20
        + 26 + memberRows * MEMBER_CELL_H + 12
        + (tableH ? 26 + tableH : 0)
        + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server, bandId: band.bandId });
    drawTitle(ctx, WIDTH, '乐团详情');

    // 副信息带: 国旗 + 服名 + 乐团 ID
    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    const hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `ID ${band.bandId}`, hx, metaMidY, 120);

    let y = HEADER_H + MARGIN;

    // 图标 + 名称
    ctx.fillStyle = '#222';
    ctx.fillRect(MARGIN, y, LOGO, LOGO);
    // 详情用横版队标: 等比缩放居中, 不拉伸
    const logo = await imageBuffer(bandLogoUrl(server, band.bandId), assetCacheKey(server, `band/${band.bandId}_logo.webp`));
    await drawFit(ctx, logo, MARGIN + 6, y + 6, LOGO - 12, LOGO - 12);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = cjkFontFamily(28);
    ctx.fillStyle = band.mainColorCode || '#FFF';
    ctx.fillText(cleanText(band.bandName || `#${band.bandId}`), MARGIN + LOGO + 16, y + 8, WIDTH - MARGIN * 2 - LOGO - 16);
    drawColorSwatch(ctx, MARGIN + LOGO + 16, y + 54, '主色', band.mainColorCode);
    drawColorSwatch(ctx, MARGIN + LOGO + 16, y + 84, '副色', band.subColorCode);
    y += LOGO + 16;

    // 简介
    if (descLines.length) {
        y = drawSectionTitle(ctx, MARGIN, y, '简介');
        y += 6;
        ctx.font = cjkFontFamily(14);
        ctx.fillStyle = '#CFD8E3';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (const line of descLines) {
            ctx.fillText(line, MARGIN, y, descWidth);
            y += 20;
        }
        y += 8;
    }

    // 应援色标注(整行色带, 与角色详情同款)
    y = drawSectionTitle(ctx, MARGIN, y, '应援色');
    y += 6;
    ctx.fillStyle = band.mainColorCode;
    ctx.fillRect(MARGIN, y, (WIDTH - MARGIN * 2) / 2, 12);
    ctx.fillStyle = band.subColorCode;
    ctx.fillRect(MARGIN + (WIDTH - MARGIN * 2) / 2, y, (WIDTH - MARGIN * 2) / 2, 12);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN + 0.5, y + 0.5, WIDTH - MARGIN * 2 - 1, 11);
    y += 26;

    // 成员
    y = drawSectionTitle(ctx, MARGIN, y, `成员（${band.members.length}）`);
    y += 6;
    y = await drawMembers(ctx, server, band.members, MARGIN, y);
    y += 12;

    // 各服信息
    if (tableH) {
        y = drawSectionTitle(ctx, MARGIN, y, '各服信息');
        y += 6;
        await drawMultiServerTable(ctx, MARGIN, y, WIDTH - MARGIN * 2, rows);
    }

    return [await outputFinalBuffer(canvas, compress)];
}

/** 多命中时的乐团列表: 图标 + ID + 名称 + 成员数 */
export async function drawBandList(server: Server, bands: Band[], compress: boolean): Promise<Array<Buffer | string>> {
    const COLUMNS = 2;
    const CELL_W = (WIDTH - MARGIN * (COLUMNS + 1)) / COLUMNS;
    const CELL_H = 108;
    const rows = Math.max(1, Math.ceil(bands.length / COLUMNS));
    const height = HEADER_H + MARGIN + rows * (CELL_H + MARGIN) + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, `共 ${bands.length} 个乐团`);

    for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        const x = MARGIN + (i % COLUMNS) * (CELL_W + MARGIN);
        const y = HEADER_H + MARGIN + Math.floor(i / COLUMNS) * (CELL_H + MARGIN);
        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(x, y, CELL_W, CELL_H);

        // 图标: 列表格用方形小图标(band_small_Icon), 等比缩放居中, 不拉伸
        ctx.fillStyle = '#222';
        ctx.fillRect(x + 8, y + 8, 92, 92);
        const icon = await imageBuffer(bandSmallIconUrl(server, band.bandId), assetCacheKey(server, `band/${band.bandId}_small_icon.webp`))
            ?? await imageBuffer(bandLogoUrl(server, band.bandId), assetCacheKey(server, `band/${band.bandId}_logo.webp`));
        await drawFit(ctx, icon, x + 12, y + 12, 84, 84);

        // 名称 + ID + 成员数 + 应援色
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = cjkFontFamily(17);
        ctx.fillStyle = '#FFF';
        ctx.fillText(cleanText(band.bandName || `#${band.bandId}`), x + 110, y + 14, CELL_W - 118);
        // 这一行含「人」等中文, 走 CJK 字体栈
        ctx.font = cjkFontFamily(12);
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`ID ${band.bandId} · ${band.members.length} 人`, x + 110, y + 40, CELL_W - 118);
        ctx.fillStyle = band.mainColorCode;
        ctx.fillRect(x + 110, y + 64, 20, 14);
        ctx.fillStyle = band.subColorCode;
        ctx.fillRect(x + 134, y + 64, 20, 14);
        ctx.fillStyle = '#BBB';
        ctx.font = cjkFontFamily(12);
        ctx.fillText(band.mainColorCode, x + 162, y + 65, CELL_W - 170);
    }

    return [await outputFinalBuffer(canvas, compress)];
}
