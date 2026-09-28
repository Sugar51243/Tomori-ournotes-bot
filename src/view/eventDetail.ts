import { createCanvas } from '@napi-rs/canvas';
import { Event } from '../types/Event';
import { formatGameDate } from '../types/Gacha';
import { drawTitle, drawDatablock, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';

const WIDTH = 640;
const HEIGHT = 300;

/** 活动详情信息图 */
export async function drawEventDetail(event: Event, compress: boolean): Promise<Array<Buffer | string>> {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, HEIGHT);
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
        { key: '开始', text: event.startAt ? formatGameDate(event.startAt) : '-' },
        { key: '结束', text: event.endAt ? formatGameDate(event.endAt) : '-' },
        { key: 'ID', text: String(event.eventId) }
    ], WIDTH - 32, { fontSize: 15 });

    return [await outputFinalBuffer(canvas, compress)];
}
