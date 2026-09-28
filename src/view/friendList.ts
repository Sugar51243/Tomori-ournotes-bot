import { createCanvas } from '@napi-rs/canvas';
import { FriendDoc } from '../types/Friend';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { drawAvatar } from '../components/avatar';
import { cleanText } from '../components/draw';
import { FONT_STACK } from '../components/fonts';

/**
 * 交友列表图: 一行一人 —— 头像 + QQ 名 + QQ 号 + 游戏 ID + 服务器。
 * 头像走 qlogo.cn 白名单 + 磁盘缓存, 拉不到则画占位块(首字符 + 确定性颜色)。
 */
const WIDTH = 900;
const MARGIN = 16;
const HEADER_H = 56;
const ROW_H = 84;
const AVATAR = 64;
/** 单图行数上限(头像拉取受每主机限流, 30 行 ≈ 首屏 3s 内) */
export const FRIENDS_PER_IMAGE = 30;

/** 交友名片上的服务器显示名 */
const SERVER_DISPLAY: Record<string, string> = {
    'hk-tw-mo': '港澳台服',
    jp: '日服',
    en: '国际服',
    kr: '韩服'
};

export async function drawFriendList(friends: FriendDoc[], compress: boolean): Promise<Array<Buffer | string>> {
    if (friends.length === 0) {
        return ['交友列表为空'];
    }
    const pages: FriendDoc[][] = [];
    for (let i = 0; i < friends.length; i += FRIENDS_PER_IMAGE) {
        pages.push(friends.slice(i, i + FRIENDS_PER_IMAGE));
    }

    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        const page = pages[p];
        const height = HEADER_H + page.length * ROW_H + MARGIN;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');
        await drawBackground(ctx, WIDTH, height);
        const pageLabel = pages.length > 1 ? `（第 ${p + 1}/${pages.length} 页）` : '';
        drawTitle(ctx, WIDTH, `交友列表（${friends.length}）${pageLabel}`);

        for (let i = 0; i < page.length; i++) {
            const friend = page[i];
            const y = HEADER_H + i * ROW_H;
            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 8);

            await drawAvatar(ctx, MARGIN + 10, y + 6, AVATAR, friend.userId, friend.userName, friend.avatarUrl);

            const tx = MARGIN + 10 + AVATAR + 14;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#FFF';
            ctx.font = `bold 18px ${FONT_STACK}`;
            ctx.fillText(cleanText(friend.userName), tx, y + 12, WIDTH - tx - MARGIN - 10);
            ctx.fillStyle = '#BBB';
            ctx.font = `13px ${FONT_STACK}`;
            ctx.fillText(`QQ ${friend.userId} · 服务器 ${SERVER_DISPLAY[friend.server] ?? friend.server}`, tx, y + 38, WIDTH - tx - MARGIN - 10);
            ctx.fillText(`游戏ID ${friend.playerId}`, tx, y + 56, WIDTH - tx - MARGIN - 10);
        }
        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
