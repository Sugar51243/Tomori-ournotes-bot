import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Stamp } from '../../types/Stamp';
import { Server, serverProfile } from '../../types/Server';
import { config } from '../../config';
import { imageBuffer, assetCacheKey } from '../../data/assets';
import { StampScope } from '../../data/stamps';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../components/list';
import { drawBackground } from '../../components/background';
import { drawServerIcon } from '../../components/serverIcon';
import { fillTextCentered } from '../../components/draw';
import { cjkFontFamily } from '../../components/fonts';

/**
 * 贴纸列表图。
 * 结果多时按 `STAMPS_PER_PAGE` 分页(每页一张图, 返回多个 Buffer), 标题标注页码 ——
 * 与交友列表 / 歌表同一套多页约定。
 */

const COLUMNS = 5;
const MARGIN = 16;
const CELL_W = 168;
const CELL_H = 208;
const ART = 140;
const HEADER_H = TITLE_BAND_H + META_BAND_H;

const SCOPE_LABEL: Record<StampScope, string> = {
    all: '全部名称',
    character: '按角色名',
    band: '按团体名'
};

/** 画一格: 贴纸 + ID + 名称 */
async function drawCell(ctx: SKRSContext2D, stamp: Stamp, x: number, y: number): Promise<void> {
    ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
    ctx.fillRect(x, y, CELL_W - 8, CELL_H - 8);

    // 贴纸原图(方形)
    ctx.fillStyle = '#222';
    ctx.fillRect(x + 10, y + 10, ART, ART);
    const buf = stamp.stampAsset
        ? await imageBuffer(stamp.url(), assetCacheKey(stamp.server, `stamp/${stamp.stampAsset}.webp`)).catch(() => undefined)
        : undefined;
    if (buf) {
        try {
            const img = await loadImage(buf);
            const scale = Math.min(ART / img.width, ART / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, x + 10 + (ART - w) / 2, y + 10 + (ART - h) / 2, w, h);
        } catch { /* 占位 */ }
    }

    // ID(用户要按 ID 取原图, 所以放在最显眼的第一行)
    const textX = x + 10;
    const textW = CELL_W - 28;
    ctx.font = 'bold 14px "Arial"';
    ctx.fillStyle = '#7ec8ff';
    fillTextCentered(ctx, `ID ${stamp.stampId}`, textX, y + 10 + ART + 16, textW);

    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, stamp.name, textX, y + 10 + ART + 36, textW);
}

export async function drawStampList(server: Server, stamps: Stamp[], scope: StampScope, keyword: string, compress: boolean): Promise<Array<Buffer | string>> {
    if (stamps.length === 0) {
        return ['错误: 没有搜索到符合条件的贴纸'];
    }
    const perPage = Math.max(1, config.stampsPerPage);
    const pages: Stamp[][] = [];
    for (let i = 0; i < stamps.length; i += perPage) {
        pages.push(stamps.slice(i, i + perPage));
    }
    // 只有一页时列数随结果数收缩(搜到 2 张不必留 5 列的空白); 分页时固定列宽, 保证各页对齐一致
    const single = pages.length === 1;

    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        const page = pages[p];
        const columns = single ? Math.min(COLUMNS, page.length) : COLUMNS;
        const rows = Math.ceil(page.length / columns);
        const width = MARGIN * 2 + columns * CELL_W;
        const height = HEADER_H + MARGIN + rows * CELL_H + MARGIN;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        await drawBackground(ctx, width, height, { server });
        const pageLabel = pages.length > 1 ? `（第 ${p + 1}/${pages.length} 页）` : '';
        drawTitle(ctx, width, `贴纸列表（${stamps.length}）${pageLabel}`);

        // 副信息带: 国旗 + 服名 + 搜索条件
        const metaMidY = drawMetaBand(ctx, width);
        await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#DDD';
        fillTextCentered(ctx, serverProfile(server).displayName, MARGIN + 28, metaMidY, 160);
        ctx.font = cjkFontFamily(12);
        ctx.fillStyle = '#9aa4b2';
        const cond = keyword ? `${SCOPE_LABEL[scope]} · 关键词「${keyword}」` : `${SCOPE_LABEL[scope]} · 未给关键词(列出全部)`;
        fillTextCentered(ctx, cond, MARGIN + 200, metaMidY, width - MARGIN * 2 - 200);

        for (let i = 0; i < page.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            await drawCell(ctx, page[i], MARGIN + col * CELL_W, HEADER_H + MARGIN + row * CELL_H);
        }

        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
