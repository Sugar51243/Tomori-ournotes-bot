import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { Event } from '../../../features/types/Event';
import { Song } from '../../../features/types/Song';
import { Server, serverProfile } from '../../../features/types/Server';
import { MusicRanking, formatScore, RANK_COLORS } from '../../../features/types/Ranking';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H, SECTION_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { fillTextCentered, formatAgo, formatDateTime } from '../../component/draw';
import { cjkFontFamily } from '../../component/fonts';
import { isEventNotRunning } from '../../../features/types/EventPhase';
import { eventAssetImage } from './eventArt';
import { endedPhaseNote, phaseTitleSuffix } from './phaseNote';

/**
 * 活动榜线图(**单服一图**)。
 *
 * 一张图里自上而下叠出该活动的每个乐曲榜(挑战演出活动 = 3 首), 每段:
 *   歌曲封面 + ID + 曲名 + 乐团 + 「最后更新时间 / 已更新多久」 + 前十(名次/玩家/综合力/出分)。
 *
 * 这是用户动态数据(与「同一实体多服对比」的静态信息不同), 故不做多服行、不进渲染缓存。
 * 版面全部是固定行高(曲名单行截断、封面固定框), 所以高度直接算得出来, 不需要先量后画。
 */

const WIDTH = 820;
const MARGIN = 12;
/** 页头 = 主标题带 + 副信息带(国旗/服名/活动 ID/种类) */
const HEADER_H = TITLE_BAND_H + META_BAND_H;
/** 歌曲头: 封面 56 + 上下留白 */
const SONG_HEAD_H = 62;
const JACKET_SIZE = 56;
const TABLE_HEAD_H = 22;
const ROW_H = 30;
/** 段与段之间的留白 */
const SECTION_BOTTOM = 14;
const FOOTER_H = 22;
/** 每段最多画的行数(上游每曲最多返回 100 名, 这里按需求只出前十) */
const MAX_ROWS = 10;
/** 单图最多画几段(正常活动 3 首; 防御性上限, 超出在页脚注明) */
const MAX_SECTIONS = 6;

const COL_RANK_X = MARGIN + 10;
const COL_NAME_X = MARGIN + 60;
const COL_POWER_RIGHT = WIDTH - MARGIN - 150;
const COL_SCORE_RIGHT = WIDTH - MARGIN - 10;
/** 玩家名可用宽度: 到综合力列左侧留 8px */
const COL_NAME_W = COL_POWER_RIGHT - 130 - 8 - COL_NAME_X;

export interface EventRankingSection {
    song: Song;
    musicId: number;
    /** 取榜用的挑战曲 id(非挑战型活动没有) */
    challengeMusicId?: number;
    ranking: MusicRanking;
    /** 上游该曲榜最后一次取数时间(ms); 非上游追踪来源时为 undefined */
    lastFetchedAt?: number;
    stale?: boolean;
    /** 上游对该曲榜报的错误种类(见 src/upstream/ranking/client.ts), 用于空榜时说明原因 */
    errorKind?: string;
    /** 这一段覆盖的名次区间(榜线查询时如 91~100; 默认前 10 时为 1~10) */
    rankStart?: number;
    rankEnd?: number;
}

/** 上游错误种类 -> 出图上的说明(与站点追踪器的文案对齐) */
function emptyReason(errorKind?: string): string {
    switch (errorKind) {
        case 'challenge_not_started': return '该曲榜尚未开始';
        case 'challenge_ranking_disabled': return '该曲未开放排名';
        case 'challenge_not_collected': return '上游尚未采集到该曲榜';
        case 'tier_not_collected': return '该曲榜没有到这个名次的数据（上游每曲只给前 100）';
        case 'pending': return '上游正在获取该曲榜, 请稍后再试';
        case 'not_found': return '上游没有该曲榜';
        case 'upstream': return '暂时连不上上游, 无法获取该曲榜';
        default: return errorKind ? `该曲榜暂无数据（${errorKind}）` : '该歌曲在此服务器暂无排行数据';
    }
}

function sectionHeight(rowCount: number): number {
    return (SECTION_BAND_H + 6) + SONG_HEAD_H + TABLE_HEAD_H + Math.max(rowCount, 1) * ROW_H + SECTION_BOTTOM;
}

/** 单段: 标题带 -> 歌曲头 -> 表头 -> 数据行 */
async function drawSection(ctx: SKRSContext2D, server: Server, section: EventRankingSection, index: number, total: number, y: number, now: number): Promise<number> {
    const { song, musicId, ranking, lastFetchedAt, stale, errorKind, rankStart, rankEnd } = section;
    const entries = ranking.entries.slice(0, MAX_ROWS);

    const title = song.musicTitle || `#${musicId}`;
    y = drawSectionBand(ctx, WIDTH, y, `第 ${index + 1}/${total} 首 · ${title}`, MARGIN);

    // ---- 歌曲头: 封面 + ID/乐团 + 更新时间, 右端标出榜的规模 ----
    ctx.fillStyle = '#222';
    ctx.fillRect(MARGIN, y, JACKET_SIZE, JACKET_SIZE);
    if (song.row?.jacketAssetName) {
        const name = String(song.row.jacketAssetName);
        const cover = await eventAssetImage(server, `Image/Jacket/${name}/${name}.webp`, `jacket/${name}.webp`);
        if (cover) ctx.drawImage(cover, MARGIN, y, JACKET_SIZE, JACKET_SIZE);
    }

    const tx = MARGIN + JACKET_SIZE + 10;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px "Arial"';
    ctx.fillStyle = '#7ec8ff';
    const idText = `ID ${musicId}`;
    ctx.fillText(idText, tx, y + 16);
    const idW = ctx.measureText(idText).width;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`· ${song.bandName || '未知乐团'}`, tx + idW + 8, y + 16, WIDTH - MARGIN - 90 - (tx + idW + 8));

    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    const updateText = lastFetchedAt
        ? `最后更新 ${formatDateTime(new Date(lastFetchedAt))} · 已更新 ${formatAgo(lastFetchedAt, now)}`
        : '最后更新 未知（上游未提供）';
    ctx.fillText(stale ? `${updateText} · 上游数据陈旧` : updateText, tx, y + 40, WIDTH - MARGIN - 90 - tx);

    if (entries.length) {
        ctx.textAlign = 'right';
        // 标注这一段覆盖的名次: 榜线查询时是「第 91~100 名」, 默认就是「前 10 名」
        const rangeText = rankEnd !== undefined && (rankStart ?? 1) > 1
            ? `第 ${rankStart ?? 1}~${rankEnd} 名`
            : `前 ${entries.length} 名`;
        fillTextCentered(ctx, rangeText, WIDTH - MARGIN, y + 40, 110);
        ctx.textAlign = 'left';
    }
    y += SONG_HEAD_H;

    // ---- 表头 ----
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 表头都带上 maxWidth(各自列的宽度), 免得将来文案变长时挤到隔壁列
    ctx.fillText('名次', COL_RANK_X, y + TABLE_HEAD_H / 2, COL_NAME_X - COL_RANK_X - 6);
    ctx.fillText('玩家', COL_NAME_X, y + TABLE_HEAD_H / 2, COL_POWER_RIGHT - 130 - COL_NAME_X - 6);
    ctx.textAlign = 'right';
    ctx.fillText('综合力', COL_POWER_RIGHT, y + TABLE_HEAD_H / 2, 130);
    ctx.fillText('出分', COL_SCORE_RIGHT, y + TABLE_HEAD_H / 2, 150);
    ctx.textAlign = 'left';
    y += TABLE_HEAD_H;

    // ---- 数据行 ----
    const midY = (row: number) => y + row * ROW_H + (ROW_H - 4) / 2;
    if (entries.length === 0) {
        ctx.font = cjkFontFamily(14);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText(emptyReason(errorKind), COL_RANK_X, midY(0), COL_POWER_RIGHT - COL_RANK_X - 6);
        return y + ROW_H + SECTION_BOTTOM;
    }

    entries.forEach((entry, row) => {
        const rowTop = y + row * ROW_H;
        ctx.fillStyle = entry.rank <= 3
            ? 'rgba(255,255,255,0.10)'
            : (row % 2 ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.15)');
        ctx.fillRect(MARGIN, rowTop, WIDTH - MARGIN * 2, ROW_H - 4);

        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = 'bold 15px "Arial"';
        ctx.fillStyle = RANK_COLORS[entry.rank - 1] ?? '#BBB';
        ctx.fillText(String(entry.rank), COL_RANK_X, midY(row), 48);

        ctx.font = cjkFontFamily(15);
        ctx.fillStyle = '#FFF';
        ctx.fillText(entry.playerName || '(无名称)', COL_NAME_X, midY(row), COL_NAME_W);

        ctx.textAlign = 'right';
        ctx.font = '13px "Arial"';
        ctx.fillStyle = '#ffd76e';
        ctx.fillText(entry.deckPower !== undefined ? formatScore(entry.deckPower) : '-', COL_POWER_RIGHT, midY(row), 130);

        ctx.font = 'bold 15px "Arial"';
        ctx.fillStyle = '#7ec8ff';
        ctx.fillText(formatScore(entry.score), COL_SCORE_RIGHT, midY(row), 150);
        ctx.textAlign = 'left';
    });

    return y + entries.length * ROW_H + SECTION_BOTTOM;
}

export async function drawEventRanking(
    server: Server,
    event: Event,
    sections: EventRankingSection[],
    compress: boolean,
    notes: string[] = [],
    /** 榜线窗口: 只查某一档时给出(如 91~100), 影响标题与页脚文案 */
    tierWindow?: { start: number; end: number }
): Promise<Array<Buffer | string>> {
    const shown = sections.slice(0, MAX_SECTIONS);
    const extra = sections.slice(MAX_SECTIONS);
    const phase = event.phase();
    const footNotes = [...notes];
    // 已结束/集计中/结果公布: 图上标出阶段并说明数据是上游保留的(进行中/未知不标)
    if (isEventNotRunning(phase)) footNotes.unshift(endedPhaseNote(phase, '榜单为上游保留的数据'));
    if (extra.length) footNotes.push(`另有 ${extra.length} 首榜单超出单图上限, 未显示`);

    const bodyH = shown.length
        ? shown.reduce((sum, s) => sum + sectionHeight(Math.min(s.ranking.entries.length, MAX_ROWS)), 0)
        : ROW_H + SECTION_BOTTOM;
    const height = HEADER_H + MARGIN + bodyH + FOOTER_H + MARGIN + (footNotes.length ? footNotes.length * 16 : 0);

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    // 背景按活动相关团选(与活动详情页同款)
    await drawBackground(ctx, WIDTH, height, { server, bandId: event.backgroundBandId() });
    const tierText = tierWindow && tierWindow.start > 1 ? ` · 第 ${tierWindow.start}~${tierWindow.end} 名` : '';
    drawTitle(ctx, WIDTH, `活动歌榜${tierText}${phaseTitleSuffix(phase)}`);

    // 副信息带: 国旗 + 服名 + 活动 ID + 种类
    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `ID ${event.eventId}`, hx, metaMidY, 80);
    hx += 86;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, event.eventName, hx, metaMidY, WIDTH - MARGIN - 150 - hx);
    ctx.textAlign = 'right';
    fillTextCentered(ctx, event.typeLabel(), WIDTH - MARGIN, metaMidY, 140);
    ctx.textAlign = 'left';

    const now = Date.now();
    let y = HEADER_H + MARGIN;
    if (shown.length === 0) {
        ctx.font = cjkFontFamily(15);
        ctx.fillStyle = '#8a93a0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('该活动当前没有可用榜单', MARGIN + 8, y + ROW_H / 2, WIDTH - MARGIN * 2);
        y += ROW_H + SECTION_BOTTOM;
    } else {
        for (let i = 0; i < shown.length; i++) {
            y = await drawSection(ctx, server, shown[i], i, shown.length, y, now);
        }
    }

    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const sourceText = tierWindow && tierWindow.start > 1
        ? `第 ${tierWindow.start}~${tierWindow.end} 名`
        : `前 ${MAX_ROWS} 名`;
    const sourceKind = isEventNotRunning(phase) ? '保留的' : '当前';
    // 实际供数的上游(回退链可能换源): 取各段榜单的 origin 去重 —— 中途换源时会把两家都列出
    const origins = [...new Set(shown.map(s => s.ranking.origin).filter((o): o is string => !!o))];
    const originText = origins.length ? `${origins.join(' / ')} · ` : '';
    ctx.fillText(`数据来源：${originText}上游各曲${sourceKind}排行${sourceText} · 生成于 ${formatDateTime(new Date(now))}`, MARGIN, y + FOOTER_H / 2, WIDTH - MARGIN * 2);
    y += FOOTER_H;
    for (const note of footNotes) {
        // 未收录曲目的 id 可能一次列好几个, 必须限宽
        ctx.fillText(note, MARGIN, y + 8, WIDTH - MARGIN * 2);
        y += 16;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
