import { createCanvas } from '@napi-rs/canvas';
import { Server, serverProfile } from '../../../features/types/Server';
import { MusicRanking, formatScore, RANK_COLORS } from '../../../features/types/Ranking';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { cjkFontFamily } from '../../component/fonts';
import { fillTextCentered } from '../../component/draw';

/**
 * 歌曲排行图(**单服一图**, 前十名)。
 * 这是用户动态数据, 与「同一实体多服对比」的静态信息无关, 故不做多服行。
 */

const WIDTH = 720;
const MARGIN = 16;
/** 页头 = 主标题带 + 副信息带(国旗/服名/曲目) */
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const ROW_H = 34;

export async function drawSongRanking(server: Server, musicId: number, title: string, ranking: MusicRanking, compress: boolean): Promise<Array<Buffer | string>> {
    const profile = serverProfile(server);
    const entries = ranking.entries;
    const height = HEADER_H + MARGIN + 44 + Math.max(entries.length, 1) * ROW_H + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, height, { server });
    drawTitle(ctx, WIDTH, `歌曲排行 Top ${entries.length || 0}`);

    // 区块头: 国旗 + 服名 + 歌曲标题(同在副信息带内, 共用视觉中心)
    const metaMidY = drawMetaBand(ctx, WIDTH);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(15);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    // 依次按实测宽度排布(服名长度不一, 固定偏移会撞车)
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '13px "Arial"';
    fillTextCentered(ctx, `#${musicId}`, hx, metaMidY, 70);
    hx += 76;
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, title, hx, metaMidY, WIDTH - MARGIN - hx);

    let y = HEADER_H + MARGIN;

    // 列头
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText('名次', MARGIN + 8, y + 12);
    ctx.fillText('玩家', MARGIN + 90, y + 12);
    ctx.fillText('分数', WIDTH - MARGIN - 150, y + 12);
    y += 30;

    if (entries.length === 0) {
        ctx.font = cjkFontFamily(15);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('该歌曲在此服务器暂无排行数据', MARGIN + 8, y + ROW_H / 2);
        return [await outputFinalBuffer(canvas, compress)];
    }

    for (const entry of entries) {
        ctx.fillStyle = entry.rank <= 3 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.25)';
        ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 4);

        ctx.textBaseline = 'middle';
        ctx.font = 'bold 16px "Arial"';
        ctx.fillStyle = RANK_COLORS[entry.rank - 1] ?? '#BBB';
        ctx.fillText(String(entry.rank), MARGIN + 8, y + (ROW_H - 4) / 2, 60);

        ctx.font = cjkFontFamily(15);
        ctx.fillStyle = '#FFF';
        ctx.fillText(entry.playerName || '(无名称)', MARGIN + 90, y + (ROW_H - 4) / 2, WIDTH - MARGIN - 90 - 160);

        ctx.font = 'bold 15px "Arial"';
        ctx.fillStyle = '#7ec8ff';
        ctx.fillText(formatScore(entry.score), WIDTH - MARGIN - 150, y + (ROW_H - 4) / 2, 140);

        y += ROW_H;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
