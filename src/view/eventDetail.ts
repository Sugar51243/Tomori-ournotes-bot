import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Event } from '../types/Event';
import { eventArtImage } from './eventArt';
import { formatGameDate } from '../types/Gacha';
import { drawTitle, drawDatablock, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';
import { drawMultiServerTable, multiServerTableHeight } from '../components/multiServerTable';
import { ServerRow } from '../data/serverInfo';

const WIDTH = 640;
/** 顶上的活动底图条高度 */
const BANNER_H = 88;
/** 活动图标高度(与底图分开显示, 不叠放) */
const LOGO_H = 54;

/**
 * 活动详情信息图(**多服组合版**)。
 * 活动图标与底图在这里**分开显示**: 底图通栏一条, 图标另起一块放在名称左侧 ——
 * 多服图要留出各服表格的位置, 叠放会挤掉表格。
 */
export async function drawEventDetail(event: Event, rows: ServerRow[], compress: boolean): Promise<Array<Buffer | string>> {
    const HEIGHT = 300 + BANNER_H + LOGO_H + 20 + (rows.length ? multiServerTableHeight(rows.length) + 34 : 0);
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, HEIGHT, { server: event.server, bandId: event.backgroundBandId() });
    drawTitle(ctx, WIDTH, '活动详情');

    // 活动底图(通栏)
    let y = 48;
    {
        const img = await eventArtImage(event, 'background');
        if (img) {
            const scale = Math.max(WIDTH / img.width, BANNER_H / img.height);
            const dw = img.width * scale;
            const dh = img.height * scale;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, y, WIDTH, BANNER_H);
            ctx.clip();
            ctx.drawImage(img, (WIDTH - dw) / 2, y + (BANNER_H - dh) * 0.28, dw, dh);
            ctx.restore();
        }
    }
    y += BANNER_H + 8;

    // 活动图标(与底图分开, 独立一块)
    {
        const img = await eventArtImage(event, 'logo');
        if (img) {
            const scale = Math.min((WIDTH / 3) / img.width, LOGO_H / img.height);
            ctx.drawImage(img, 16, y, img.width * scale, img.height * scale);
        }
    }
    y += LOGO_H + 8;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#FFF';
    ctx.font = `26px ${FONT_STACK}`;
    const nameLines = wrapTextLines(ctx, event.eventName, WIDTH - 32, 2);
    for (const line of nameLines) {
        ctx.fillText(line, 16, y, WIDTH - 32);
        y += 36;
    }
    y += 12;
    y = drawDatablock(ctx, 16, y, [
        { key: '开始', text: event.startAt ? formatGameDate(event.startAt, event.server) : '-' },
        { key: '结束', text: event.endAt ? formatGameDate(event.endAt, event.server) : '-' },
        { key: 'ID', text: String(event.eventId) }
    ], WIDTH - 32, { fontSize: 15 });

    if (rows.length) {
        ctx.fillStyle = '#3a5fa8';
        ctx.fillRect(16, y, 4, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = `bold 17px ${FONT_STACK}`;
        ctx.textBaseline = 'middle';
        ctx.fillText('各服信息', 30, y + 10);
        await drawMultiServerTable(ctx, 16, y + 26, WIDTH - 32, rows);
    }

    return [await outputFinalBuffer(canvas, compress)];
}
