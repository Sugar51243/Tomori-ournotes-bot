import { createCanvas } from '@napi-rs/canvas';
import { Event } from '../types/Event';
import { formatGameDate } from '../types/Gacha';
import { drawTitle, drawDatablock, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';
import { drawMultiServerTable, multiServerTableHeight } from '../components/multiServerTable';
import { ServerRow } from '../data/serverInfo';

const WIDTH = 640;

/** 活动详情信息图 */
export async function drawEventDetail(event: Event, rows: ServerRow[], compress: boolean): Promise<Array<Buffer | string>> {
    const HEIGHT = 300 + (rows.length ? multiServerTableHeight(rows.length) + 34 : 0);
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, HEIGHT, { server: event.server });
    drawTitle(ctx, WIDTH, '活动详情');

    let y = 64;
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
