import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas';
import { cardThumbUrl, supportCardThumbUrl, jacketUrl, imageBuffer, assetCacheKey } from '../../../upstream/adapter';
import { Server, serverProfile } from '../../../features/types/Server';
import { Song } from '../../../features/types/Song';
import { formatScore } from '../../../features/types/Ranking';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H, SECTION_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { cjkFontFamily } from '../../component/fonts';
import { fillTextCentered, cleanText, wrapTextLines } from '../../component/draw';
import type { OptimizeResult, DeckSuggestion, SongGroup } from '../../../deck/optimize';

/**
 * 组卡器出图（与网页组卡器同逻辑的算法结果）。
 *
 * 版面(信息密集、固定行高):
 *   推荐队伍  —— 5 张成员卡缩略图 + 5 张留影卡缩略图 + 总综合力 + 分项（components 全列）
 *   收益/效率曲 —— 前 12 行（活动模式按点数/小时，普通模式按评级优先）: 封面/曲名/难度/评级/局时/效率或收益
 *   其余队伍(活动模式) —— 紧凑一行一套
 * 页脚注明假设（技能按基础 +100%、启发式搜索不保证全局最优）与数据来源。
 */

const WIDTH = 860;
const MARGIN = 12;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const FOOTER_H = 30;

const MEMBER_W = 96;
const MEMBER_H = 140;
const SUPPORT_W = 68;
const SUPPORT_H = 44;
const ROW_H = 26;
const MAX_SONG_ROWS = 12;

export interface DeckView {
    playerId: string;
    title: string;
    tgwCardRank: number;
    /** 活动模式: 用的是哪期活动的报酬表（指定 eventId 时可能是往期活动） */
    eventName?: string;
    songs: Map<number, Song>;
    result: OptimizeResult;
}

const DIFF_LABELS = ['EZ', 'NM', 'HD', 'EX'];

/** 画一组卡缩略图(成员卡比例 3:4, 留影卡接近方形), 返回占用的总宽 */
async function drawCards(
    ctx: SKRSContext2D,
    drawer: { url: (cardId: number) => string; cache: (cardId: number) => string; w: number; h: number },
    cardIds: number[],
    x: number,
    y: number
): Promise<void> {
    let cx = x;
    for (const id of cardIds) {
        ctx.fillStyle = '#222';
        ctx.fillRect(cx, y, drawer.w, drawer.h);
        const buf = await imageBuffer(drawer.url(id), drawer.cache(id)).catch(() => undefined);
        if (buf) {
            try { ctx.drawImage(await loadImage(buf), cx, y, drawer.w, drawer.h); } catch { /* 占位 */ }
        }
        cx += drawer.w + 6;
    }
}

/** 综合力分项的一行紧凑展示(只列非零项之外的都列, 便于核对) */
function componentTexts(deck: DeckSuggestion): string[] {
    const labels: Record<string, string> = {
        members: '卡力', characterRank: '角色等级', snaps: '留影', bandItems: '乐队道具',
        leaderSkill: '队长技能', typeLink: '类型链接', typeBonus: '类型加成', favoredMusic: '偏好曲', tgwCard: 'T.G.W'
    };
    return Object.entries(deck.power.components)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${labels[k] ?? k} ${formatScore(v)}`);
}

async function drawDeckSection(ctx: SKRSContext2D, server: Server, view: DeckView, y: number): Promise<number> {
    const deck = view.result.decks[0];
    const title = view.result.mode === 'event' ? '推荐队伍（活动模式）' : '最高综合力队伍';
    y = drawSectionBand(ctx, WIDTH, y, title, MARGIN);

    if (!deck) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('没有算得出队伍（账号包至少需要 5 张成员卡）', MARGIN + 8, y + 16);
        return y + ROW_H + 8;
    }

    // 成员卡一行 + 留影卡一行 + 右侧综合力
    const cardsTop = y + 4;
    await drawCards(ctx, {
        url: id => cardThumbUrl(server, id),
        cache: id => assetCacheKey(server, `card/${id}_thumb_deck.webp`),
        w: MEMBER_W, h: MEMBER_H
    }, deck.members.map(m => m.cardId), MARGIN, cardsTop);
    await drawCards(ctx, {
        url: id => supportCardThumbUrl(server, id),
        cache: id => assetCacheKey(server, `support/${id}_thumb_deck.webp`),
        w: SUPPORT_W, h: SUPPORT_H
    }, deck.supports.map(s => s.cardId), MARGIN, cardsTop + MEMBER_H + 4);

    // 右下: 总综合力 + 分项
    const infoX = MARGIN + 5 * (MEMBER_W + 6) + 8;
    const infoW = WIDTH - MARGIN - infoX;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText('总综合力', infoX, cardsTop + 2);
    ctx.font = 'bold 26px "Arial"';
    ctx.fillStyle = '#ffd76e';
    ctx.fillText(formatScore(deck.power.total), infoX, cardsTop + 18, infoW);
    let cy = cardsTop + 52;
    ctx.font = cjkFontFamily(11);
    for (const line of wrapTextLines(ctx, componentTexts(deck).join(' · '), infoW, 6)) {
        ctx.fillStyle = '#DDD';
        ctx.fillText(line, infoX, cy, infoW);
        cy += 15;
    }
    if (deck.bonus && (deck.bonus.eventPt || deck.bonus.shopPt)) {
        ctx.fillStyle = '#7ec8ff';
        ctx.fillText(`活动点 +${(deck.bonus.eventPt / 100).toFixed(2)}% · 交换所 +${(deck.bonus.shopPt / 100).toFixed(2)}%`, infoX, cy + 2, infoW);
    }

    let bottom = cardsTop + MEMBER_H + SUPPORT_H + 8;

    // 活动模式的其余队伍: 紧凑一行
    if (view.result.mode === 'event' && view.result.decks.length > 1) {
        ctx.font = cjkFontFamily(11);
        ctx.fillStyle = '#9aa4b2';
        const rest = view.result.decks.slice(1).map((d, i) =>
            `#${i + 2} 综合力 ${formatScore(d.power.total)}${d.bonus ? `（点 +${(d.bonus.eventPt / 100).toFixed(1)}%）` : ''}`);
        ctx.fillText(rest.join('    '), MARGIN + 4, bottom + 2, WIDTH - MARGIN * 2);
        bottom += 16;
    }
    return bottom + 6;
}

function songRow(ctx: SKRSContext2D, server: Server, view: DeckView, group: SongGroup, rank: number, y: number, eventMode: boolean, jacket?: Image, deck?: DeckSuggestion): void {
    const lead = group.lead;
    const song = view.songs.get(group.musicId);
    ctx.fillStyle = rank <= 3 ? 'rgba(255,255,255,0.08)' : (rank % 2 ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.15)');
    ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 3);
    const midY = y + (ROW_H - 3) / 2;
    ctx.textBaseline = 'middle';

    // 名次 + 封面 + 曲名
    ctx.textAlign = 'left';
    ctx.font = 'bold 12px "Arial"';
    ctx.fillStyle = '#BBB';
    ctx.fillText(String(rank), MARGIN + 6, midY, 22);

    const jx = MARGIN + 30;
    const JACKET = 20;
    const jy = y + (ROW_H - 3 - JACKET) / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(jx, jy, JACKET, JACKET);
    if (jacket) ctx.drawImage(jacket, jx, jy, JACKET, JACKET);

    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    ctx.fillText(cleanText(song?.musicTitle ?? `#${group.musicId}`), jx + JACKET + 8, midY, 300);

    // 难度们
    const diffs = group.picks.map(p => DIFF_LABELS[p.difficulty] ?? String(p.difficulty)).join('/');
    ctx.font = '12px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(diffs, MARGIN + 420, midY, 80);
    ctx.fillStyle = '#DDD';
    ctx.fillText(String(lead.displayLevel), MARGIN + 500, midY, 40);

    // 右侧各列带中文单位, 必须走 CJK 字体栈(裸 Arial 会出豆腐块)
    ctx.textAlign = 'right';
    ctx.font = cjkFontFamily(12);
    if (eventMode) {
        ctx.fillStyle = '#7ec8ff';
        ctx.fillText(`${formatScore(lead.pointsPerHour)}/时`, WIDTH - MARGIN - 230, midY, 110);
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`${lead.playsPerHour.toFixed(1)} 局/时`, WIDTH - MARGIN - 120, midY, 100);
        if (deck) {
            ctx.fillStyle = '#DDD';
            const idx = view.result.decks.indexOf(deck) + 1;
            ctx.fillText(`#${idx} · ${formatScore(deck.power.total)}`, WIDTH - MARGIN - 6, midY, 110);
        }
    } else {
        ctx.fillStyle = '#ffd76e';
        ctx.fillText(`评级 ${lead.rankLabel}`, WIDTH - MARGIN - 230, midY, 110);
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`${lead.playsPerHour.toFixed(1)} 局/时`, WIDTH - MARGIN - 120, midY, 100);
    }
    ctx.textAlign = 'left';
}

export async function drawDeckBuilder(server: Server, view: DeckView, compress: boolean): Promise<Buffer> {
    const songCount = Math.min(view.result.songs.length, MAX_SONG_ROWS);
    const deckBlockH = 16 + MEMBER_H + SUPPORT_H + 24 + (view.result.mode === 'event' && view.result.decks.length > 1 ? 20 : 0);
    const songsBlockH = (SECTION_BAND_H + 6) + 20 + Math.max(songCount, 1) * ROW_H + 8;
    const notesH = view.result.notes.length * 15;
    const height = HEADER_H + MARGIN + deckBlockH + songsBlockH + notesH + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    const titleText = view.result.mode === 'event'
        ? `组卡 · 活动推荐${view.eventName ? ` · ${view.eventName}` : ''}`
        : '组卡 · 最高综合力';
    drawTitle(ctx, WIDTH, titleText);

    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 140);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 12;
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `ID ${view.playerId}`, hx, metaMidY, 100);
    hx += 106;
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, view.title, hx, metaMidY, WIDTH - MARGIN - 200 - hx);
    ctx.textAlign = 'right';
    ctx.font = '12px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `T.G.W ${view.tgwCardRank}`, WIDTH - MARGIN, metaMidY, 160);
    ctx.textAlign = 'left';

    let y = HEADER_H + MARGIN;
    y = await drawDeckSection(ctx, server, view, y);

    // 收益/效率曲：活动模式 = 队伍×歌曲 的收益排行（与网页组卡器同口径），普通模式 = 效率曲
    const eventMode = view.result.mode === 'event';
    y = drawSectionBand(ctx, WIDTH, y,
        eventMode ? '收益排行（每曲取最佳队伍，点数/小时）' : '效率曲（评级优先、同级时长最短）', MARGIN);
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textBaseline = 'middle';
    ctx.fillText('名次', MARGIN + 6, y + 10, 22);
    ctx.fillText('曲目', MARGIN + 58, y + 10, 300);
    ctx.fillText('难度', MARGIN + 420, y + 10, 80);
    ctx.fillText('等级', MARGIN + 500, y + 10, 40);
    ctx.textAlign = 'right';
    ctx.fillText(eventMode ? '点数/时' : '评级', WIDTH - MARGIN - 230, y + 10, 110);
    ctx.fillText('局/时', WIDTH - MARGIN - 120, y + 10, 100);
    if (eventMode) ctx.fillText('队伍', WIDTH - MARGIN - 6, y + 10, 110);
    ctx.textAlign = 'left';
    y += 20;

    // **每首歌只出一行**（取它收益最高/评级最好的那支队伍）——
    // web 的 combos 是「队伍×歌曲」逐对列表, 直接铺开会把同一首歌按不同队伍重复好几行, 出图太冗余。
    // 两边列表都按最优在前排序, 所以「首次出现」就是该曲的最佳行。
    const groups: SongGroup[] = [];
    const deckOf = new Map<SongGroup, DeckSuggestion>();
    const seenMusic = new Set<number>();
    const consider = (group: SongGroup, deck?: DeckSuggestion): void => {
        if (seenMusic.has(group.musicId)) return;
        seenMusic.add(group.musicId);
        groups.push(group);
        if (deck) deckOf.set(group, deck);
    };
    if (eventMode) {
        for (const c of view.result.combos) {
            consider(c.group, c.deck);
            if (groups.length >= MAX_SONG_ROWS) break;
        }
    } else {
        for (const g of view.result.songs) {
            consider(g);
            if (groups.length >= MAX_SONG_ROWS) break;
        }
    }
    const songs = groups;
    // 先取封面再画行(渲染循环是同步的, 不能在里面等网络)
    const jackets = new Map<number, Image>();
    for (const group of songs) {
        const song = view.songs.get(group.musicId);
        const name = song?.row?.jacketAssetName ? String(song.row.jacketAssetName) : '';
        if (!name) continue;
        const s = song?.server ?? server;
        const buf = await imageBuffer(jacketUrl(s, name), `images/jacket/${s}/${name}.webp`).catch(() => undefined);
        if (!buf) continue;
        try { jackets.set(group.musicId, await loadImage(buf)); } catch { /* 占位 */ }
    }
    if (!songs.length) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('没有可推荐的谱面（谱面效率数据缺评级门槛）', MARGIN + 8, y + ROW_H / 2);
        y += ROW_H;
    } else {
        groups.forEach((group, i) => songRow(ctx, server, view, group, i + 1, y + i * ROW_H, eventMode, jackets.get(group.musicId), deckOf.get(group)));
        y += songs.length * ROW_H;
    }

    // notes + 页脚
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#8a93a0';
    for (const note of view.result.notes) {
        ctx.fillText(note, MARGIN, y + 8, WIDTH - MARGIN * 2);
        y += 15;
    }
    ctx.fillText('与网页组卡器同一算法（技能按基础 +100%、启发式搜索不保证全局最优）；数据来源：网页账号包快照 + bot 效率模型', MARGIN, y + 12, WIDTH - MARGIN * 2);

    return outputFinalBuffer(canvas, compress);
}
