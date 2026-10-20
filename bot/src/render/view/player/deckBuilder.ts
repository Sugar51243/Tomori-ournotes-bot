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
 * 两套路版面：
 * - 普通模式（最高综合力）：推荐队伍（5 成员 + 5 留影 + 综合力分项）+ 效率曲（评级优先、同级时长最短）。
 * - 活动模式（收益最大化）：推荐编队（同一套卡只画一次，编号引用）+ 三组榜
 *   （自由live 混池 3 首 / 自由live 活动加成乐队 1 首 / 挑战live 1 首），每行是它自己的编队，
 *   列含点数/时、道具/时（都已乘活动加成）与「相加分」。bot 侧只出「相加最大」这一张表（减负）。
 * 页脚注明假设（技能基准 60%、启发式搜索不保证全局最优、相加口径）与数据来源。
 */

const WIDTH = 900;
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

/**
 * 按图片**原始宽高比**把图放进给定框里（contain 适配，剩余部分留底色）。
 * 卡面比例和框的比例不一定一致，直接 drawImage(img, x, y, w, h) 会把卡面拉变形。
 */
function drawImageFit(ctx: SKRSContext2D, img: Image, x: number, y: number, boxW: number, boxH: number): void {
    const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : boxW / boxH;
    let w = boxW;
    let h = w / ratio;
    if (h > boxH) {
        h = boxH;
        w = h * ratio;
    }
    ctx.drawImage(img, x + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
}

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
            try { drawImageFit(ctx, await loadImage(buf), cx, y, drawer.w, drawer.h); } catch { /* 占位 */ }
        }
        cx += drawer.w + 6;
    }
}

/**
 * 给队首那张成员卡标「队长」：队长技能只由它决定，卡序又决定「成员 i ↔ 留影 i」的配对，
 * 所以出图必须让用户看出谁是队长。
 */
function markLeader(ctx: SKRSContext2D, x: number, y: number, w: number, h: number): void {
    ctx.strokeStyle = '#ffd76e';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x + 1, y + h - 15, 32, 14);
    ctx.font = 'bold 10px "Arial"';
    ctx.fillStyle = '#ffd76e';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('队长', x + 4, y + h - 8);
}

/** 综合力分项的一行紧凑展示(只列非零项之外的都列, 便于核对) */
function componentTexts(deck: DeckSuggestion): string[] {
    const labels: Record<string, string> = {
        members: '卡力', characterRank: '角色等级', snaps: '留影', bandItems: '乐队道具',
        leaderSkill: '队长技能', typeLink: '类型链接', typeBonus: '类型加成', favoredMusic: '偏好曲', tgwCard: 'TGW'
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
    markLeader(ctx, MARGIN, cardsTop, MEMBER_W, MEMBER_H);
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

function songRow(ctx: SKRSContext2D, view: DeckView, group: SongGroup, rank: number, y: number, jacket?: Image): void {
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

    const jx = MARGIN + 34;
    const JACKET = 22;
    const jy = y + (ROW_H - 3 - JACKET) / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(jx, jy, JACKET, JACKET);
    if (jacket) drawImageFit(ctx, jacket, jx, jy, JACKET, JACKET);

    // 曲名 · 歌曲ID · 乐团（与活动模式同一套口径）
    const textX = jx + JACKET + 8;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    ctx.fillText(cleanText(song?.musicTitle ?? `#${group.musicId}`), textX, midY, 214);
    ctx.font = '11px "Arial"';
    ctx.fillStyle = '#8a93a0';
    ctx.fillText(`#${group.musicId}`, textX + 222, midY, 60);
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(cleanText(song?.bandName ?? ''), textX + 288, midY, 116);

    // 难度 + 等级
    const diffs = group.picks.map(p => DIFF_LABELS[p.difficulty] ?? String(p.difficulty)).join('/');
    ctx.font = '11px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(diffs, textX + 410, midY, 70);
    ctx.fillStyle = '#DDD';
    ctx.fillText(String(lead.displayLevel), textX + 486, midY, 36);

    // 右侧各列带中文单位, 必须走 CJK 字体栈(裸 Arial 会出豆腐块)
    ctx.textAlign = 'right';
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#ffd76e';
    ctx.fillText(`评级 ${lead.rankLabel}`, WIDTH - MARGIN - 230, midY, 110);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`${lead.playsPerHour.toFixed(1)} 局/时`, WIDTH - MARGIN - 120, midY, 100);
    ctx.textAlign = 'left';
}

/** 标题带 + 元信息带（两种模式共用） */
async function drawHeader(ctx: SKRSContext2D, server: Server, view: DeckView, titleText: string): Promise<void> {
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
}

/** 图上只留这些关键的提醒（别的注解不进图） */
// 「不计乐队道具加成」也要进图：道具没公开时综合力会偏低，不写明会被当成算错
const ESSENTIAL_NOTE_MARKS = ['暂无谱面', '本次活动没有', '技能基准', '不计乐队道具加成'];

/** 页脚：先画筛过的关键提醒，再画一行固定说明 */
function drawFooter(ctx: SKRSContext2D, notes: string[], y: number, footerText: string): void {
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#8a93a0';
    for (const note of notes) {
        ctx.fillText(note, MARGIN, y + 8, WIDTH - MARGIN * 2);
        y += 15;
    }
    ctx.fillText(footerText, MARGIN, y + 12, WIDTH - MARGIN * 2);
    y += 24;
    void y;
}

export async function drawDeckBuilder(server: Server, view: DeckView, compress: boolean): Promise<Buffer> {
    if (view.result.mode === 'event') return drawEventBuilder(server, view, compress);

    const songCount = Math.min(view.result.songs.length, MAX_SONG_ROWS);
    const deckBlockH = 16 + MEMBER_H + SUPPORT_H + 24;
    const songsBlockH = (SECTION_BAND_H + 6) + 20 + Math.max(songCount, 1) * ROW_H + 8;
    const notesH = view.result.notes.length * 15;
    const height = HEADER_H + MARGIN + deckBlockH + songsBlockH + notesH + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    await drawHeader(ctx, server, view, '组卡 · 最高综合力');

    let y = HEADER_H + MARGIN;
    y = await drawDeckSection(ctx, server, view, y);

    y = drawSectionBand(ctx, WIDTH, y, '效率曲（评级优先、同级时长最短）', MARGIN);
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textBaseline = 'middle';
    ctx.fillText('名次', MARGIN + 6, y + 10, 22);
    ctx.fillText('曲目 · 歌曲ID · 乐团', MARGIN + 64, y + 10, 380);
    ctx.fillText('难度', MARGIN + 484, y + 10, 70);
    ctx.fillText('等级', MARGIN + 560, y + 10, 40);
    ctx.textAlign = 'right';
    ctx.fillText('评级', WIDTH - MARGIN - 230, y + 10, 110);
    ctx.fillText('局/时', WIDTH - MARGIN - 120, y + 10, 100);
    ctx.textAlign = 'left';
    y += 20;

    const songs = view.result.songs.slice(0, MAX_SONG_ROWS);
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
        songs.forEach((group, i) => songRow(ctx, view, group, i + 1, y + i * ROW_H, jackets.get(group.musicId)));
        y += songs.length * ROW_H;
    }

    drawFooter(ctx, [], y, '启发式推荐 · 技能基准见上方说明 · 数据：网页账号包 + bot 效率模型');

    return outputFinalBuffer(canvas, compress);
}

// ---------------------------------------------------------------- 活动模式版面

/**
 * 活动模式：**每首歌一个带边框的卡片块**，块内三行各自带标签 ——
 *   曲目  [曲绘] 曲名 · #歌曲ID · 乐团 · 难度（可达该评级的合并显示）· 评级
 *   编队  [成员/留影成对缩略条，金框=队长]   该曲综合力 · 活动点加成 · 交换所加成
 *   收益  局/时 · 单局收益 · 点数/时 · 道具/时 · 相加分（每项都写明是什么）
 * 块与块之间留空、块内每行不同底色 —— 三层信息不再挤在一格里。
 */
const EVENT_ROW_H = 228;
/**
 * 编队缩略图尺寸 —— **按上游素材的真实宽高比**定，不然会被拉变形：
 * 成员卡缩略图 384×512（3:4）、留影卡缩略图 512×288（16:9，横图）。
 */
const EVENT_MEMBER_W = 60;
const EVENT_MEMBER_H = 80;
const EVENT_SUPPORT_W = 88;
const EVENT_SUPPORT_H = 50;
/** 两层共用的格子宽（成员、留影各自居中，保证上下按位对得齐） */
const EVENT_SLOT_W = 92;
/** bot 只出「相加最大」表：混池 3 首 + 活动乐队 1 首 + 挑战 1 首 */
const EVENT_FREE_ROWS = 3;

/** 卡片块内的列坐标（三行的标签列 + 各行内容起点，块内共用一套） */
const COL = {
    /** 右半边的固定列（左半边是「曲名→ID→乐团→时长」顺势排，不固定） */
    diff2: MARGIN + 560,
    rank2: MARGIN + 660,
    needPower: MARGIN + 750,
    rank: MARGIN + 10,
    label: MARGIN + 46,
    content: MARGIN + 92,
    stat1: MARGIN + 92,
    stat2: MARGIN + 186,
    stat3: MARGIN + 400,
    stat4: MARGIN + 536,
    stat5: MARGIN + 672,
} as const;
/** 编队缩略条：成员 38×52 + 留影 22×30 成对并排（第 i 张成员卡配第 i 张留影卡） */
const STRIP_SLOT_W = EVENT_MEMBER_W + EVENT_SUPPORT_W + 4;

function deckCardKey(deck: DeckSuggestion): string {
    return `${deck.members.map(m => m.cardId).join('-')}/${deck.supports.map(s => s.cardId).join('-')}`;
}

/**
 * 活动模式的图：
 *   ① 推荐编队（同一套卡只画一次，编号引用）
 *   ② 三组榜：自由live 混池（相加最大前 3）+ 活动加成乐队（1 首）+ 挑战live（1 首）
 *   ③ notes 与页脚
 * 与网页组卡器同一算法、同一口径；bot 侧只出「点数+道具相加最大」这一张表（减负）。
 */
async function drawEventBuilder(server: Server, view: DeckView, compress: boolean): Promise<Buffer> {
    const boards = view.result.boards ?? [];
    const boardRows = (board: (typeof boards)[number]): number => {
        const rows = board.tables.find(t => t.metric === 'sum')?.rows.length ?? 0;
        return Math.min(rows, board.scope === 'free-all' ? EVENT_FREE_ROWS : 1);
    };
    const boardsH = boards.reduce((sum, b) => sum + SECTION_BAND_H + 2 + Math.max(boardRows(b), 1) * EVENT_ROW_H, 0);
    const essentialCount = view.result.notes.filter(n => ESSENTIAL_NOTE_MARKS.some(mark => n.includes(mark))).length;
    const notesH = essentialCount * 15 + 26;
    const height = HEADER_H + MARGIN + boardsH + notesH + FOOTER_H + MARGIN + 24;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server });
    await drawHeader(ctx, server, view, `组卡 · 活动收益${view.eventName ? ` · ${view.eventName}` : ''}`);

    // ---- 每行的编队直接画进表格里：先把卡图都取回来（渲染循环是同步的，不能在里面等网络）----
    const memberThumbs = new Map<number, Image>();
    const supportThumbs = new Map<number, Image>();
    for (const board of boards) {
        for (const table of board.tables) {
            if (table.metric !== 'sum') continue;
            for (const row of table.rows.slice(0, board.scope === 'free-all' ? EVENT_FREE_ROWS : 1)) {
                for (const m of row.deck.members) {
                    if (memberThumbs.has(m.cardId)) continue;
                    const buf = await imageBuffer(cardThumbUrl(server, m.cardId), assetCacheKey(server, `card/${m.cardId}_thumb_deck.webp`)).catch(() => undefined);
                    if (buf) try { memberThumbs.set(m.cardId, await loadImage(buf)); } catch { /* 占位 */ }
                }
                for (const s of row.deck.supports) {
                    if (supportThumbs.has(s.cardId)) continue;
                    const buf = await imageBuffer(supportCardThumbUrl(server, s.cardId), assetCacheKey(server, `support/${s.cardId}_thumb_deck.webp`)).catch(() => undefined);
                    if (buf) try { supportThumbs.set(s.cardId, await loadImage(buf)); } catch { /* 占位 */ }
                }
            }
        }
    }

    let y = HEADER_H + MARGIN;

    // ---- 三组榜（bot 只出「点数+道具相加最大」这一张表） ----
    for (const board of boards) {
        const table = board.tables.find(t => t.metric === 'sum');
        if (!table) continue;
        const limit = board.scope === 'free-all' ? EVENT_FREE_ROWS : 1;
        const rows = table.rows.slice(0, limit);
        y = drawSectionBand(
            ctx, WIDTH, y,
            `${board.title}（点数+道具相加最大，前 ${rows.length} 首）` +
                `　相加基准 点数 ${formatScore(Math.round(board.ptMax))} / 道具 ${formatScore(Math.round(board.itemsMax))}`,
            MARGIN
        );

        // 先取封面（渲染循环同步，不能在里面等网络）
        const jackets = new Map<number, Image>();
        for (const row of rows) {
            const song = view.songs.get(row.musicId);
            const name = song?.row?.jacketAssetName ? String(song.row.jacketAssetName) : '';
            if (!name) continue;
            const s = song?.server ?? server;
            const buf = await imageBuffer(jacketUrl(s, name), `images/jacket/${s}/${name}.webp`).catch(() => undefined);
            if (!buf) continue;
            try { jackets.set(row.musicId, await loadImage(buf)); } catch { /* 占位 */ }
        }

        if (!rows.length) {
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = '#8a93a0';
            ctx.fillText('没有可推荐的谱面（谱面效率数据缺评级门槛或缺该活动的报酬表）', MARGIN + 8, y + 20);
            y += 40;
            continue;
        }
        rows.forEach((row, i) => {
            // 每首歌一张卡片：外框 + 三行（曲目 / 编队 / 收益），每行各有标签与底色，不再挤成一格
            const top = y + i * EVENT_ROW_H + 4;
            const blockW = WIDTH - MARGIN * 2;
            const blockH = EVENT_ROW_H - 8;
            ctx.fillStyle = 'rgba(0,0,0,0.30)';
            ctx.fillRect(MARGIN, top, blockW, blockH);
            ctx.strokeStyle = 'rgba(255,255,255,0.14)';
            ctx.lineWidth = 1;
            ctx.strokeRect(MARGIN + 0.5, top + 0.5, blockW - 1, blockH - 1);
            // 卡片内三行之间拉两条分隔线：曲目 / 编队 / 收益 各自成格
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.beginPath();
            ctx.moveTo(MARGIN + 1, top + 50.5);
            ctx.lineTo(MARGIN + blockW - 1, top + 50.5);
            ctx.moveTo(MARGIN + 1, top + 196.5);
            ctx.lineTo(MARGIN + blockW - 1, top + 196.5);
            ctx.stroke();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';

            // 名次徽标（卡片左上）
            ctx.font = 'bold 15px "Arial"';
            ctx.fillStyle = '#ffd76e';
            ctx.fillText(`#${i + 1}`, COL.rank, top + 20, 40);

            const song = view.songs.get(row.musicId);

            // ---- 行1 曲目 ----
            const y1 = top + 24;
            ctx.font = cjkFontFamily(11);
            ctx.fillStyle = '#8a93a0';
            ctx.fillText('曲目', COL.label, y1, 44);
            const JACKET = 40;
            ctx.fillStyle = '#222';
            ctx.fillRect(COL.content, y1 - JACKET / 2, JACKET, JACKET);
            const jacket = jackets.get(row.musicId);
            if (jacket) drawImageFit(ctx, jacket, COL.content, y1 - JACKET / 2, JACKET, JACKET);
            // 曲名 → #ID → 乐团 → 时长：**从左往右顺势排**（ID 与乐团紧贴曲名，不留空档）
            const textX = COL.content + JACKET + 8;
            let cursor = textX;
            const title = cleanText(song?.musicTitle ?? `曲目 ${row.musicId}`);
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = '#FFF';
            const titleWidth = Math.min(ctx.measureText(title).width, 250);
            ctx.fillText(title, cursor, y1, 250);
            cursor += titleWidth + 12;
            ctx.font = '11px "Arial"';
            ctx.fillStyle = '#8a93a0';
            ctx.fillText(`#${row.musicId}`, cursor, y1, 60);
            cursor += 66;
            ctx.font = cjkFontFamily(11);
            ctx.fillStyle = '#9aa4b2';
            const band = cleanText(song?.bandName ?? '');
            const bandWidth = Math.min(ctx.measureText(band).width, 130);
            ctx.fillText(band, cursor, y1, 130);
            cursor += bandWidth + 14;
            // 时长（mm:ss，不含结算开销）
            const seconds = Math.round(row.musicMs / 1000);
            ctx.fillStyle = '#c9d2de';
            ctx.fillText(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, cursor, y1, 48);
            // 右半边固定列：难度（可达该评级的合并显示）/ 等级 · 评级 · 需综合力
            const variants = row.difficultyVariants?.length ? row.difficultyVariants : [row.difficulty];
            const diffs = variants.map(d => DIFF_LABELS[d] ?? String(d)).join('/');
            ctx.font = '11px "Arial"';
            ctx.fillStyle = '#DDD';
            ctx.fillText(`${diffs} ${row.displayLevel}`, COL.diff2, y1, 88);
            // 带中文的文案必须走 CJK 字体栈（裸 Arial 出豆腐块）
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = row.rankNumber >= 6 ? '#ffd76e' : '#DDD';
            ctx.fillText(`评级 ${row.rankLabel}`, COL.rank2, y1, 70);
            // 这一档评级最少要多少综合力（同评级各难度取最小）
            ctx.font = cjkFontFamily(11);
            ctx.fillStyle = '#8a93a0';
            ctx.fillText(`需综合力 ${formatScore(row.requiredPower)}`, COL.needPower, y1, 130);

            // ---- 行2 编队：**上面一层成员卡、下面一层留影卡**（各自带标签，别混成一排）----
            const memberTop = top + 56;
            const supportTop = top + 140;
            const stripX = COL.content + 46;
            const deckInfoX = stripX + 5 * EVENT_SLOT_W + 16;
            ctx.font = cjkFontFamily(11);
            ctx.fillStyle = '#8a93a0';
            ctx.fillText('编队', COL.label, memberTop + EVENT_MEMBER_H / 2, 44);
            ctx.fillText('成员卡', COL.content, memberTop + EVENT_MEMBER_H / 2, 42);
            ctx.fillText('留影卡', COL.content, supportTop + EVENT_SUPPORT_H / 2, 42);
            for (let slot = 0; slot < row.deck.members.length; slot++) {
                const slotX = stripX + slot * EVENT_SLOT_W + (EVENT_SLOT_W - EVENT_MEMBER_W) / 2;
                // 成员卡（队长是队首那张，标金框）
                ctx.fillStyle = '#222';
                ctx.fillRect(slotX, memberTop, EVENT_MEMBER_W, EVENT_MEMBER_H);
                const member = memberThumbs.get(row.deck.members[slot].cardId);
                if (member) drawImageFit(ctx, member, slotX, memberTop, EVENT_MEMBER_W, EVENT_MEMBER_H);
                if (slot === 0) {
                    ctx.strokeStyle = '#ffd76e';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(slotX + 1, memberTop + 1, EVENT_MEMBER_W - 2, EVENT_MEMBER_H - 2);
                }
                // 留影卡（快照）：与上面第 i 张成员卡按位配对，居中画在自己的格子里
                const support = row.deck.supports[slot];
                if (!support) continue;
                const sx = stripX + slot * EVENT_SLOT_W + (EVENT_SLOT_W - EVENT_SUPPORT_W) / 2;
                ctx.fillStyle = '#222';
                ctx.fillRect(sx, supportTop, EVENT_SUPPORT_W, EVENT_SUPPORT_H);
                const supportImg = supportThumbs.get(support.cardId);
                if (supportImg) drawImageFit(ctx, supportImg, sx, supportTop, EVENT_SUPPORT_W, EVENT_SUPPORT_H);
            }
            ctx.font = cjkFontFamily(12);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText(`队伍综合力 ${formatScore(row.deck.power.total)}（金框 = 队长）`, deckInfoX, memberTop + 20, 360);
            ctx.fillStyle = '#7ec8ff';
            ctx.fillText(
                `活动点加成 +${((row.deck.bonus?.eventPt ?? 0) / 100).toFixed(1)}%`,
                deckInfoX, memberTop + 44, 200
            );
            ctx.fillText(
                `交换所加成 +${((row.deck.bonus?.shopPt ?? 0) / 100).toFixed(1)}%`,
                deckInfoX, memberTop + 68, 200
            );

            // ---- 行3 收益（每项都写明是什么）----
            const y3 = top + 210;
            const ptPerPlay = row.pointsPerPlay * (1 + (row.deck.bonus?.eventPt ?? 0) / 10000);
            const itemsPerPlay = row.itemsPerPlay * (1 + (row.deck.bonus?.shopPt ?? 0) / 10000);
            ctx.font = cjkFontFamily(11);
            ctx.fillStyle = '#8a93a0';
            ctx.fillText('收益', COL.label, y3, 44);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText('局/时', COL.stat1, y3, 60);
            ctx.fillStyle = '#DDD';
            ctx.fillText(row.playsPerHour.toFixed(1), COL.stat1 + 38, y3, 60);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText('单局收益', COL.stat2, y3, 80);
            ctx.fillStyle = '#DDD';
            ctx.fillText(`${formatScore(Math.round(ptPerPlay))} pt + ${formatScore(Math.round(itemsPerPlay))} 道具`, COL.stat2 + 60, y3, 150);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText('点数/时', COL.stat3, y3, 70);
            ctx.fillStyle = '#7ec8ff';
            ctx.fillText(formatScore(Math.round(row.pointsPerHour)), COL.stat3 + 54, y3, 80);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText('道具/时', COL.stat4, y3, 70);
            ctx.fillStyle = '#8de0a8';
            ctx.fillText(formatScore(Math.round(row.itemsPerHour)), COL.stat4 + 54, y3, 80);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText('相加分', COL.stat5, y3, 60);
            ctx.fillStyle = '#ffd76e';
            ctx.fillText(row.sumScore.toFixed(2), COL.stat5 + 48, y3, 60);
        });
        y += rows.length * EVENT_ROW_H + 4;
    }

    // 图下面只留**必要**的提醒（缺挑战曲、没有活动乐队曲目这类「为什么少了一块」），
    // 口径说明与实现细节不往图上堆 —— 需要看细节到网页组卡器，那边的「说明」里有完整一份。
    const essentials = view.result.notes.filter(n => ESSENTIAL_NOTE_MARKS.some(mark => n.includes(mark)));
    drawFooter(ctx, essentials, y, '启发式推荐 · 技能基准见上方说明 · 点数/道具/时已含活动加成 · 数据：网页账号包 + bot 效率模型');

    return outputFinalBuffer(canvas, compress);
}
