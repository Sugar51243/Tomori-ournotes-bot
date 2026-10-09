import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas';
import { cardThumbUrl, imageBuffer, itemIconUrl, bandSmallIconUrl, assetCacheKey } from '../../../upstream/adapter';
import { Server, serverProfile } from '../../../features/types/Server';
import { formatScore } from '../../../features/types/Ranking';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H, SECTION_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { cjkFontFamily } from '../../component/fonts';
import { fillTextCentered, cleanText, formatAgo } from '../../component/draw';
import type { MasterBundle } from '../../../deck/types';
import type { BandDeck } from '../../../deck/bandDecks';
import type { SongStatusSummary } from '../../../webPlatform/client';

/**
 * 「查玩家」的**账号包数据图**（网页账号包快照，非实时）。
 *
 * 版面（信息密集）:
 *   歌曲完成状态 —— 分难度 有记录/完成/FC/AP 的小表 + 合计
 *   乐队道具     —— 逐乐队一行: 乐队图标 + 道具（名称 Lv）
 *   理论最高队伍 —— 逐乐队一行: 5 张成员卡缩略图 + 综合力
 * 全部遵循网页的**公开开关**：隐藏的类别不会出现在这里（上游档案图与它无关，照常出）。
 */

const WIDTH = 900;
const MARGIN = 12;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const FOOTER_H = 44;

const ROW_H = 26;
const DECK_ROW_H = 62;
const CARD_W = 44;
const CARD_H = 58;
const DIFF_LABELS = ['EZ（简单）', 'NM（普通）', 'HD（困难）', 'EX（专家）'];

export interface PackageView {
    playerId: string;
    server: Server;
    /** 展示名（账号包备注 / 玩家名 / 上游名字） */
    title: string;
    /** 上游档案的状态: 缺失/暂不可用时在图脚如实说明（本图只代表账号包数据） */
    upstream: 'ok' | 'missing' | 'unavailable';
    /** 歌曲完成状态（没公开歌曲时为 undefined） */
    songStatus?: SongStatusSummary;
    /** 账号包里的乐队道具等级 [bandItemId, level] */
    bandItems: Array<[number, number]>;
    /** 各乐队理论最高综合力队伍（成员不足 5 张的乐队没有） */
    bandDecks: BandDeck[];
    /** 查表用（乐队/道具的名字都在里面）；网页平台不可用时为 undefined（对应段落下沉为提示） */
    bundle?: MasterBundle;
    tgwCardRank: number;
    /** 账号包快照的更新时间（ms） */
    accountUpdatedAt?: number;
}

function bandName(bundle: MasterBundle | undefined, bandId: number): string {
    if (!bundle) return `#${bandId}`;
    const idx = bundle.bands.find(b => b[0] === bandId)?.[1];
    return idx === undefined ? `#${bandId}` : (bundle.t[idx] ?? `#${bandId}`);
}

async function loadThumb(server: Server, cardId: number): Promise<Image | undefined> {
    const buf = await imageBuffer(cardThumbUrl(server, cardId), assetCacheKey(server, `card/${cardId}_thumb_pkg.webp`)).catch(() => undefined);
    if (!buf) return undefined;
    try { return await loadImage(buf); } catch { return undefined; }
}

async function drawSongStatus(ctx: SKRSContext2D, server: Server, s: SongStatusSummary, y: number): Promise<number> {
    y = drawSectionBand(ctx, WIDTH, y, '歌曲完成状态（账号包快照）', MARGIN);
    ctx.textBaseline = 'middle';
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textAlign = 'left';
    ctx.fillText('难度', MARGIN + 8, y + 10);
    ctx.textAlign = 'right';
    const cols: Array<[string, number]> = [['有记录', 320], ['完成', 420], ['FC', 520], ['AP', 620]];
    for (const [label, x] of cols) ctx.fillText(label, MARGIN + x, y + 10);
    ctx.textAlign = 'left';
    y += 20;

    const row = (label: string, v: { played: number; lc: number; fc: number; ap: number }, highlight = false): void => {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = highlight ? '#FFF' : '#DDD';
        ctx.fillText(label, MARGIN + 8, y + ROW_H / 2, 200);
        ctx.font = 'bold 13px "Arial"';
        const values: Array<[number, number, string]> = [
            [MARGIN + 320, v.played, '#DDD'], [MARGIN + 420, v.lc, '#DDD'],
            [MARGIN + 520, v.fc, '#7ec8ff'], [MARGIN + 620, v.ap, '#ffd76e']
        ];
        for (const [x, val, color] of values) {
            ctx.textAlign = 'right';
            ctx.fillStyle = color;
            ctx.fillText(String(val), x, y + ROW_H / 2, 80);
        }
        ctx.textAlign = 'left';
        y += ROW_H;
    };

    // 分难度在前（紧凑），合计殿后
    for (let d = 0; d < Math.min(4, s.byDifficulty.length); d++) row(DIFF_LABELS[d], s.byDifficulty[d]);
    row('合计（按歌曲）', { played: s.total, lc: s.lc, fc: s.fc, ap: s.ap }, true);
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#8a93a0';
    ctx.fillText('「完成」= 任一难度通关（判定刻度为参考站的推断值）；合计按「歌曲」去重（任一难度达成即算）', MARGIN + 8, y + 8, WIDTH - MARGIN * 2);
    return y + 20;
}

async function drawBandItems(ctx: SKRSContext2D, view: PackageView, y: number): Promise<number> {
    y = drawSectionBand(ctx, WIDTH, y, '乐队道具', MARGIN);
    if (!view.bundle) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.textBaseline = 'middle';
        ctx.fillText('查表数据（网页 master bundle）暂不可用，这一节稍后重试', MARGIN + 8, y + ROW_H / 2);
        return y + ROW_H + 6;
    }
    const levels = new Map(view.bandItems);
    const byBand = new Map<number, Array<{ name: string; imagePath: string; level: number }>>();
    for (const [id, nameIdx, bandId] of view.bundle.bandItems) {
        const level = levels.get(id) ?? 0;
        if (level <= 0) continue;   // 未升级的不占位（信息密度优先）
        const list = byBand.get(bandId) ?? [];
        list.push({ name: view.bundle.t[nameIdx] ?? `#${id}`, imagePath: '', level });
        byBand.set(bandId, list);
    }
    if (!byBand.size) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('没有已升级的乐队道具（或该账号未公开道具数据）', MARGIN + 8, y + ROW_H / 2);
        return y + ROW_H + 6;
    }
    ctx.textBaseline = 'middle';
    for (const [bandId, items] of [...byBand.entries()].sort((a, b) => a[0] - b[0])) {
        const icon = await imageBuffer(bandSmallIconUrl(view.server, bandId), assetCacheKey(view.server, `band/${bandId}_small.webp`)).catch(() => undefined);
        if (icon) { try { ctx.drawImage(await loadImage(icon), MARGIN, y + 3, 20, 20); } catch { /* 空 */ } }
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#FFF';
        ctx.fillText(bandName(view.bundle, bandId), MARGIN + 26, y + ROW_H / 2, 180);
        ctx.font = cjkFontFamily(12);
        ctx.fillStyle = '#DDD';
        const chips = items.map(i => `${i.name} Lv.${i.level}`).join('   ');
        ctx.fillText(chips, MARGIN + 210, y + ROW_H / 2, WIDTH - MARGIN - 210);
        y += ROW_H;
    }
    return y + 6;
}

async function drawBandDecks(ctx: SKRSContext2D, view: PackageView, y: number): Promise<number> {
    y = drawSectionBand(ctx, WIDTH, y, '各乐队理论最高综合力队伍', MARGIN);
    ctx.textBaseline = 'middle';
    if (!view.bundle || !view.bandDecks.length) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText(
            view.bundle ? '算不出队伍（某个乐队至少需要 5 张成员卡；或该账号未公开卡片/道具数据）'
                : '查表数据（网页 master bundle）暂不可用，这一节稍后重试',
            MARGIN + 8, y + ROW_H / 2);
        return y + ROW_H + 6;
    }
    for (const deck of view.bandDecks) {
        // 逐个乐队: 图标+名 + 5 张成员卡 + 综合力
        const icon = await imageBuffer(bandSmallIconUrl(view.server, deck.bandId), assetCacheKey(view.server, `band/${deck.bandId}_small.webp`)).catch(() => undefined);
        const top = y + 2;
        if (icon) { try { ctx.drawImage(await loadImage(icon), MARGIN, top + 2, 22, 22); } catch { /* 空 */ } }
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#FFF';
        ctx.fillText(bandName(view.bundle, deck.bandId), MARGIN + 30, top + 13, 150);

        let cx = MARGIN + 190;
        for (const m of deck.members) {
            const img = await loadThumb(view.server, m.cardId);
            ctx.fillStyle = '#222';
            ctx.fillRect(cx, top, CARD_W, CARD_H);
            if (img) ctx.drawImage(img, cx, top, CARD_W, CARD_H);
            cx += CARD_W + 4;
        }
        ctx.textAlign = 'right';
        ctx.font = 'bold 15px "Arial"';
        ctx.fillStyle = '#ffd76e';
        ctx.fillText(formatScore(deck.power.total), WIDTH - MARGIN, top + 18, 130);
        // 口径说明在页脚, 行内不再压字(保持卡面整洁)
        ctx.textAlign = 'left';
        y += DECK_ROW_H;
    }
    return y + 6;
}

export async function drawPlayerPackage(view: PackageView, compress: boolean): Promise<Buffer> {
    const statusH = view.songStatus ? 20 + 5 * ROW_H + 20 : ROW_H + 6;
    const itemsH = ROW_H * Math.max(1, Math.min(view.bundle?.bandItems.length ?? 1, 8));
    const decksH = view.bandDecks.length ? view.bandDecks.length * DECK_ROW_H : ROW_H + 6;
    const height = HEADER_H + MARGIN + (SECTION_BAND_H + 6 + statusH) + (SECTION_BAND_H + 6 + itemsH) + (SECTION_BAND_H + 6 + decksH) + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, height, { server: view.server });
    drawTitle(ctx, WIDTH, '账号包 · 完成状态与理论队伍');

    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(view.server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, view.server, 16);
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
    fillTextCentered(ctx, view.title, hx, metaMidY, WIDTH - MARGIN - 210 - hx);
    ctx.textAlign = 'right';
    ctx.font = '12px "Arial"';
    ctx.fillStyle = '#9aa4b2';
    fillTextCentered(ctx, `T.G.W ${view.tgwCardRank}`, WIDTH - MARGIN, metaMidY, 200);
    ctx.textAlign = 'left';

    let y = HEADER_H + MARGIN;

    if (view.songStatus) {
        y = await drawSongStatus(ctx, view.server, view.songStatus, y);
    } else {
        y = drawSectionBand(ctx, WIDTH, y, '歌曲完成状态', MARGIN);
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('该账号未公开歌曲数据（到网页「我的账号」可以调整公开开关）', MARGIN + 8, y + ROW_H / 2);
        y += ROW_H + 6;
    }

    y = await drawBandItems(ctx, view, y);
    y = await drawBandDecks(ctx, view, y);

    // 页脚: 口径 + 来源 + 快照时间 + 上游状态
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#8a93a0';
    ctx.textBaseline = 'middle';
    const snapshot = view.accountUpdatedAt ? `账号包快照于 ${formatAgo(view.accountUpdatedAt, Date.now())} 导入 · ` : '';
    const upstreamNote = view.upstream === 'ok' ? '' :
        view.upstream === 'missing' ? '上游游戏档案查不到（本图仅为网页账号包数据） · ' : '上游游戏档案暂不可用 · ';
    ctx.fillText(
        `理论最高队伍 = 该乐队成员 + 账号最强留影 + 该乐队道具（不含歌曲相关加成；技能按基础 +100%，与网页组卡器同算法）`,
        MARGIN, y + 10, WIDTH - MARGIN * 2);
    ctx.fillText(
        `数据来源：网页账号包（玩家自行导入的快照，非实时）· ${upstreamNote}${snapshot}展示范围遵循网页公开开关`,
        MARGIN, y + 26, WIDTH - MARGIN * 2);

    return outputFinalBuffer(canvas, compress);
}
