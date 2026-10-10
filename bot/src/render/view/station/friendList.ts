import { createCanvas } from '@napi-rs/canvas';
import { config } from '../../../config';
import { FriendDoc } from '../../../features/types/Friend';
import { drawTitle, outputFinalBuffer } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawAvatar } from '../../component/avatar';
import { cleanText } from '../../component/draw';
import { FONT_STACK } from '../../component/fonts';
import { serverDisplayName } from '../../../features/types/Server';

/**
 * 交友列表图: 一行一人 —— 头像 + 昵称 + 身份(QQ 号/网页用户) + 游戏 ID + 服务器。
 * 头像白名单见 render/component/avatar.ts(qlogo.cn 或网页平台账号头像), 拉不到则画占位块。
 */
const WIDTH = 900;
const MARGIN = 16;
const HEADER_H = 56;
const ROW_H = 84;
const AVATAR = 64;

export async function drawFriendList(friends: FriendDoc[], compress: boolean): Promise<Array<Buffer | string>> {
    if (friends.length === 0) {
        return ['交友列表为空'];
    }
    // 单图行数上限: 头像拉取受每主机限流, 默认 30 行 ≈ 首屏 3s 内
    const perPage = Math.max(1, config.friendsPerPage);
    const pages: FriendDoc[][] = [];
    for (let i = 0; i < friends.length; i += perPage) {
        pages.push(friends.slice(i, i + perPage));
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
            // 网页用户(web:<账号ID>)在 QQ 群里没有 QQ 号可看, 标出来源即可
            const identity = friend.userId.startsWith('web:') ? '网页用户' : `QQ ${friend.userId}`;
            ctx.fillText(`${identity} · 服务器 ${serverDisplayName(friend.server)}`, tx, y + 38, WIDTH - tx - MARGIN - 10);
            ctx.fillText(`游戏ID ${friend.playerId}`, tx, y + 56, WIDTH - tx - MARGIN - 10);
        }
        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
