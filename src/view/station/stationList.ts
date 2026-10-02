import { createCanvas } from '@napi-rs/canvas';
import { RoomView, normalizeStationTime } from '../../types/Station';
import { drawTitle, outputFinalBuffer } from '../../components/list';
import { drawBackground } from '../../components/background';
import { drawAvatar } from '../../components/avatar';
import { cleanText, formatAgo, wrapTextLines } from '../../components/draw';
import { FONT_STACK } from '../../components/fonts';

/**
 * 车站列表图: 一行一个房间 —— 房号(大字) + 剩余时间 + 上传者(头像/昵称/多久前) + 原消息。
 * 数据来自本服务 MongoDB(只含未过期记录)或 tsugu 兼容的 roomList 入参。
 */
const WIDTH = 900;
const MARGIN = 16;
const HEADER_H = 56;
const ROW_H = 92;
const AVATAR = 56;
/** 单图行数上限 */
export const ROOMS_PER_IMAGE = 30;

/** 剩余时间文本: 秒/分秒 */
function formatRemain(expireAt: Date | undefined, now: number): string {
    if (!expireAt) return '';
    const sec = Math.max(0, Math.round((expireAt.getTime() - now) / 1000));
    if (sec < 60) return `剩余 ${sec} 秒`;
    return `剩余 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

export async function drawStationList(rooms: RoomView[], expireAtList: (Date | undefined)[], compress: boolean): Promise<Array<Buffer | string>> {
    if (rooms.length === 0) {
        return ['车站列表为空'];
    }
    const now = Date.now();
    const pages: number[][] = [];
    for (let i = 0; i < rooms.length; i += ROOMS_PER_IMAGE) {
        pages.push(rooms.map((_, idx) => idx).slice(i, i + ROOMS_PER_IMAGE));
    }

    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        const page = pages[p];
        const height = HEADER_H + page.length * ROW_H + MARGIN;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');
        await drawBackground(ctx, WIDTH, height);
        const pageLabel = pages.length > 1 ? `（第 ${p + 1}/${pages.length} 页）` : '';
        drawTitle(ctx, WIDTH, `车站列表（${rooms.length}）${pageLabel}`);

        for (let i = 0; i < page.length; i++) {
            const idx = page[i];
            const room = rooms[idx];
            const y = HEADER_H + i * ROW_H;
            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 8);

            await drawAvatar(ctx, MARGIN + 10, y + 10, AVATAR, room.userId, room.userName, room.avatarUrl);

            const tx = MARGIN + 10 + AVATAR + 14;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#FFF';
            ctx.font = `bold 22px ${FONT_STACK}`;
            ctx.fillText(String(room.number), tx, y + 10, 260);
            ctx.fillStyle = '#9aa4b2';
            ctx.font = `13px ${FONT_STACK}`;
            ctx.fillText(`${cleanText(room.userName)} 来自${room.source} · ${formatAgo(room.timeMs ?? normalizeStationTime(room.time), now)}`, tx, y + 40, WIDTH - tx - MARGIN - 10);
            ctx.fillStyle = '#CFD8E3';
            ctx.font = `14px ${FONT_STACK}`;
            const lines = wrapTextLines(ctx, cleanText(room.rawMessage), WIDTH - tx - MARGIN - 10, 2);
            let ly = y + 59;
            for (const line of lines) {
                ctx.fillText(line, tx, ly, WIDTH - tx - MARGIN - 10);
                ly += 18;
            }
            // 剩余时间(右上)
            const remain = formatRemain(expireAtList[idx], now);
            if (remain) {
                ctx.fillStyle = '#9aa4b2';
                ctx.font = `13px ${FONT_STACK}`;
                ctx.textAlign = 'right';
                ctx.fillText(remain, WIDTH - MARGIN - 10, y + 14, 200);
                ctx.textAlign = 'left';
            }
        }
        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
