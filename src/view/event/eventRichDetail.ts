import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas';
import { Event, EventCardRef, EventRewardItem, eventTypeLabel } from '../../types/Event';
import { Server, serverProfile } from '../../types/Server';
import { imageBuffer, assetCacheKey, cardThumbUrl, supportCardThumbUrl, itemIconUrl, jacketUrl } from '../../data/assets';
import { eventArtImage, eventAssetImage } from './eventArt';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../components/list';
import { drawBackground } from '../../components/background';
import { drawServerIcon } from '../../components/serverIcon';
import { relatedGachasOfEvent } from '../../data/relations';
import { drawRelatedSection, relatedSectionHeight, toRelatedItems } from '../relatedSection';
import { fillTextCentered, formatDateTime } from '../../components/draw';
import { FONT_STACK, cjkFontFamily } from '../../components/fonts';

/**
 * 活动详情**丰富版**(单服查询时使用)。
 *
 * 版式(自上而下, 块间用整条底色标题带 + 分隔线区分):
 *   1. 顶图: 活动底图 + 活动图标叠放(与网页同款)
 *   2. 基础信息: 左=名称/种类/时间信息; 右=活动道具
 *   3. 加成对象: 成员卡 ── 分界线 ── 支援卡, 条件加成用小表格
 *   4. 点数奖励: 每格 = pt + 奖励图标 + 数量, 每行 4 格
 *   5. 总奖励: 图标 + 数量, 左到右排列, 放不下换行
 *   6. 演出报酬 / 挑战演出报酬: 得分评级 + 分数门槛 + 活动点数 + 道具
 *
 * 与 songDetail 一样**先量后排**: 同一段排版先跑在测量画布上取高度, 再建正式画布重画。
 */

/**
 * 画布宽度。内容按「尽量少留白」排: 各区块的列宽都贴着内容定, 所以整体能从 1000 收到 880。
 */
const WIDTH = 820;
const MARGIN = 10;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
/**
 * 顶图栏保留底图的比例: 上下各切掉 1/4, **只留中间 50%**。
 * 底图是 4:3(1920x1440), 820 宽等比缩放后约 615 高, 取中段就是约 308 高。
 */
const BANNER_KEEP_RATIO = 0.5;
/**
 * 取不到底图时顶图栏用的兜底高度。
 */
const BANNER_FALLBACK_H = 112;
/** 活动图标占画布宽度的比例 */
const LOGO_WIDTH_RATIO = 0.28;

/** 顶图栏高度: 底图按宽度等比缩放后的高度 × 保留比例 */
function bannerHeightFor(img: Image | undefined): number {
    if (!img || !img.width) return BANNER_FALLBACK_H;
    return Math.round(WIDTH * img.height / img.width * BANNER_KEEP_RATIO);
}

/** 底图在顶图栏里的原始(等比缩放后)高度, 用于算上下裁掉多少 */
function bannerFullHeight(img: Image | undefined): number {
    if (!img || !img.width) return 0;
    return WIDTH * img.height / img.width;
}
const ROW_H = 22;
/** 点数奖励: 每行 6 格 */
const MILESTONE_COLUMNS = 6;
const MILESTONE_H = 30;
/** 得分评级字母: scoreRank 2..7 -> D/C/B/A/S/SS */
const SCORE_RANKS = ['-', '-', 'D', 'C', 'B', 'A', 'S', 'SS'];
/**
 * 加成对象左右分栏: 左=成员卡, 右=支援卡, 每边 3 个一行。
 * 两张表并排而不是上下叠, 高度直接省掉一半。
 */
const BONUS_COL_GAP = 12;
const BONUS_COL_W = (WIDTH - MARGIN * 2 - BONUS_COL_GAP) / 2;
const BONUS_PER_ROW = 3;
const CARD_CELL_W = BONUS_COL_W / BONUS_PER_ROW;
const CARD_TEXT_H = 32;
// 6 档必须排在同一行: (820 - 20) / 6 = 133.3, 取 132 才放得下
const REWARD_ROW_CELL_W = 132;
const REWARD_ROW_CELL_H = 44;
/** 奖励条目里「×数量」文本的最大宽度(数量可到 7 位, 如 ×3,000,000) */
const REWARD_COUNT_MAX_W = 92;
/**
 * 奖励条目之间的间距。留宽一点, 让总奖励自然分成两行 ——
 * 挤成一行虽然省高度, 但数量位数差别大时容易看错图标归属。
 */
const REWARD_CHIP_GAP = 26;

const CJK = FONT_STACK;
type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

function humanDuration(ms: number): string {
    const abs = Math.max(0, ms);
    const d = Math.floor(abs / 86400000);
    const h = Math.floor((abs % 86400000) / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    if (d > 0) return `${d}天${h}小时`;
    if (h > 0) return `${h}小时${m}分`;
    return `${m}分`;
}

function statusText(event: Event): string {
    const now = new Date();
    const status = event.status(now);
    if (status === 'upcoming' && event.startAt) return `未开始 · 距开始 ${humanDuration(event.startAt.getTime() - now.getTime())}`;
    if (status === 'open' && event.endAt) return `进行中 · 距结束 ${humanDuration(event.endAt.getTime() - now.getTime())}`;
    if (event.endAt) return `已结束 · ${humanDuration(now.getTime() - event.endAt.getTime())}前结束`;
    return '-';
}

/** 区块标题带: 通铺底色 + 左侧竖条, 让分区一眼能分开 */
function section(ctx: Ctx, y: number, title: string): number {
    return drawSectionBand(ctx, WIDTH, y, title, MARGIN);
}

/** 活动新曲角标: 黑框红底白字, 紧跟在曲目 ID 右方(与 ID 同行) */
function drawNewSongBadge(ctx: Ctx, x: number, centerY: number): void {
    const text = '活动新曲';
    ctx.font = cjkFontFamily(9);
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const h = 14;
    ctx.fillStyle = '#c8102e';
    ctx.fillRect(x, centerY - h / 2, w, h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, centerY - h / 2 + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#FFF';
    ctx.textAlign = 'center';
    fillTextCentered(ctx, text, x + w / 2, centerY, w - 4);
    ctx.textAlign = 'left';
}

/** 细分割线 */
function divider(ctx: Ctx, y: number): number {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y + 0.5);
    ctx.lineTo(WIDTH - MARGIN, y + 0.5);
    ctx.stroke();
    return y + 10;
}

/** 道具小图标 */
async function drawItemIcon(ctx: Ctx, server: Server, imagePath: string, itemId: number, x: number, y: number, size: number): Promise<void> {
    if (!imagePath) return;
    // 同一个道具图标会出现在多个里程碑格子里, 必须走内存缓存
    const img = await eventAssetImage(server, `${imagePath}/${imagePath.split('/').at(-1)}.webp`, `item/${itemId}.webp`);
    if (img) ctx.drawImage(img, x, y, size, size);
}

/** 一张卡片: 缩图在上, 下面两行(ID+名称 / 加成区间) */
async function drawCard(ctx: Ctx, server: Server, ref: EventCardRef, bonus: number[] | undefined, x: number, y: number, cellW = CARD_CELL_W): Promise<void> {
    const thumb = ref.kind === 'member' ? { w: 48, h: 64 } : { w: 76, h: 43 };
    const thumbX = x + (cellW - 8 - thumb.w) / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(thumbX, y, thumb.w, thumb.h);
    // 新出的卡面在 tw/kr/en 镜像上可能还没有, 走逐区域回退
    const logical = ref.kind === 'member'
        ? `MemberCard/${ref.cardId}/member_thumbnail/member_thumbnail.webp`
        : `SupportCard/${ref.assetId}/snap_thumbnail/snap_thumbnail.webp`;
    const img = await eventAssetImage(server, logical, `${ref.kind}/${ref.assetId}_thumb.webp`);
    if (img) {
        const scale = Math.min(thumb.w / img.width, thumb.h / img.height);
        ctx.drawImage(img, thumbX + (thumb.w - img.width * scale) / 2, y + (thumb.h - img.height * scale) / 2, img.width * scale, img.height * scale);
    }

    const tw = cellW - 8;
    const ty = y + thumb.h + 4;
    ctx.textBaseline = 'middle';
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, `ID ${ref.cardId} ${ref.name}`, x + 2, ty + 7, tw);
    if (bonus?.length) {
        ctx.font = 'bold 11px "Arial"';
        ctx.fillStyle = '#ffd76e';
        fillTextCentered(ctx, `+${bonus[0].toFixed(1)}% ~ +${bonus[bonus.length - 1].toFixed(1)}%`, x + 2, ty + 21, tw);
    }
}

function cardRowHeight(kind: 'member' | 'support'): number {
    return (kind === 'member' ? 64 : 43) + 4 + CARD_TEXT_H;
}

/** 卡片网格: 从 x 起、每行 perRow 个, 返回下一个 y */
async function drawCardGrid(ctx: Ctx, server: Server, cards: Array<{ ref: EventCardRef; bonus?: number[] }>, x: number, y: number, perRow = BONUS_PER_ROW): Promise<number> {
    if (!cards.length) return y;
    const rowH = cardRowHeight(cards[0].ref.kind);
    const cellW = BONUS_COL_W / perRow;
    for (let i = 0; i < cards.length; i++) {
        await drawCard(ctx, server, cards[i].ref, cards[i].bonus, x + (i % perRow) * cellW, y + Math.floor(i / perRow) * rowH, cellW);
    }
    return y + Math.ceil(cards.length / perRow) * rowH;
}

/** 一个奖励条目(道具或卡片): 图标 + ×数量, 返回占用宽度 */
async function drawRewardChip(ctx: Ctx, server: Server, item: EventRewardItem, x: number, y: number, iconSize = 24): Promise<void> {
    if (item.kind === 'item') {
        await drawItemIcon(ctx, server, item.imagePath, item.id, x, y, iconSize);
    } else {
        const logical = item.kind === 'member'
            ? `MemberCard/${item.id}/member_thumbnail/member_thumbnail.webp`
            : `SupportCard/${item.id}/snap_thumbnail/snap_thumbnail.webp`;
        const img = await eventAssetImage(server, logical, `${item.kind}/${item.id}_thumb.webp`);
        if (img) {
            const scale = Math.min(iconSize / img.width, iconSize / img.height);
            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
        }
    }
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#E6ECF5';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const label = `×${item.count.toLocaleString('en-US')}`;
    ctx.fillText(label, x + iconSize + 3, y + iconSize / 2, REWARD_COUNT_MAX_W);
}

/** 一个奖励条目会占多宽 —— 与 drawRewardChip 用同一套算法, 保证流式排版算得准 */
function rewardChipWidth(ctx: Ctx, item: EventRewardItem, iconSize: number): number {
    ctx.font = cjkFontFamily(12);
    const label = `×${item.count.toLocaleString('en-US')}`;
    return iconSize + 3 + Math.min(ctx.measureText(label).width, REWARD_COUNT_MAX_W) + REWARD_CHIP_GAP;
}

/** 分数门槛的紧凑写法: 2230465 -> 2.23M(表里空间有限) */
function compactScore(v?: number): string {
    if (v === undefined) return '';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
    return v.toLocaleString('en-US');
}

/** 排版(不含页头底色)。返回内容结束的 y */
async function renderContent(ctx: Ctx, server: Server, event: Event, bannerH: number, bannerImg: Image | undefined, logoImg: Image | undefined): Promise<number> {
    // 画布顶部已有标题带 + 副信息带(共 80px), 从 HEADER_H 起画
    let y = HEADER_H;

    // ---- 1. 顶图: 底图取中间 50%(上下切掉) + 活动图标叠放在右侧 ----
    if (bannerImg) {
        const fullH = bannerFullHeight(bannerImg);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y, WIDTH, bannerH);
        ctx.clip();
        // 上边切掉的高度 = (1 - 保留比例) / 2
        ctx.drawImage(bannerImg, 0, y - fullH * (1 - BANNER_KEEP_RATIO) / 2, WIDTH, fullH);
        ctx.restore();
    }
    ctx.fillStyle = 'rgba(10, 12, 20, 0.35)';
    ctx.fillRect(0, y, WIDTH, bannerH);
    if (logoImg) {
        // 占画布宽度的 LOGO_WIDTH_RATIO, 在顶图栏里垂直居中、贴右侧
        const w = WIDTH * LOGO_WIDTH_RATIO;
        const h = w * logoImg.height / logoImg.width;
        ctx.drawImage(logoImg, WIDTH - MARGIN - 12 - w, y + (bannerH - h) / 2, w, h);
    }
    y += bannerH;

    // ---- 2. 基础信息 ----
    y = section(ctx, y, '基础信息');
    const leftX = MARGIN + 6;
    const rightX = 436;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `bold 22px ${CJK}`;
    ctx.fillStyle = '#FFF';
    ctx.fillText(event.eventName, leftX, y, rightX - leftX - 24);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#8fd0ff';
    ctx.fillText(event.typeLabel(), leftX, y + 32, rightX - leftX - 24);

    const timeRows: Array<[string, string]> = [
        ['开放时间', formatDateTime(event.startAt)],
        ['结束时间', formatDateTime(event.endAt)],
        ['总时长', event.durationMs() !== undefined ? humanDuration(event.durationMs()!) : '-'],
        ['状态', statusText(event)]
    ];
    if (event.displayEndAt && event.displayEndAt.getTime() !== event.endAt?.getTime()) {
        timeRows.push(['展示结束', formatDateTime(event.displayEndAt)]);
    }
    let ty = y + 56;
    ctx.textBaseline = 'middle';
    for (const [key, value] of timeRows) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(key, leftX, ty + ROW_H / 2);
        ctx.fillStyle = '#E6ECF5';
        ctx.fillText(value, leftX + 72, ty + ROW_H / 2, rightX - leftX - 92);
        ty += ROW_H;
    }

    // 右半: 活动道具
    ctx.textBaseline = 'middle';
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText('活动道具', rightX, y + 10);
    if (event.itemId) {
        await drawItemIcon(ctx, server, event.itemImagePath, event.itemId, rightX, y + 28, 48);
        ctx.font = cjkFontFamily(14);
        ctx.fillStyle = '#FFF';
        ctx.fillText(event.itemName, rightX + 58, y + 42, WIDTH - MARGIN - rightX - 62);
        ctx.font = '12px "Arial"';
        ctx.fillStyle = '#7ec8ff';
        ctx.fillText(`ID ${event.itemId}`, rightX + 58, y + 64);
    }
    const panelBottom = Math.max(ty, y + 88);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN + 0.5, y - 6.5, WIDTH - MARGIN * 2 - 1, panelBottom - y + 18);
    y = panelBottom + 18;

    // ---- 2.5 相关曲目(基础信息栏下方): 活动新曲在前, 后接挑战曲(多为老歌) ----
    if (event.songs.length) {
        const typeTag = eventTypeLabel(event.eventType);
        y = section(ctx, y, `相关曲目（${event.songs.length}）${typeTag ? `(${typeTag})` : ''}`);
        const SIZE = 46;
        const CELL = SIZE + 6 + 202;
        // 曲目多了要换行: 每行按画布宽算得下几个, 测量与绘制走同一套算术
        const cols = Math.max(1, Math.floor((WIDTH - MARGIN * 2 - 4) / CELL));
        for (const [i, song] of event.songs.entries()) {
            const sx = MARGIN + 4 + (i % cols) * CELL;
            const sy = y + Math.floor(i / cols) * (SIZE + 10);
            ctx.fillStyle = '#222';
            ctx.fillRect(sx, sy, SIZE, SIZE);
            const cover = await eventAssetImage(server, `Image/Jacket/${song.jacketAssetName}/${song.jacketAssetName}.webp`, `jacket/${song.jacketAssetName}.webp`);
            if (cover) ctx.drawImage(cover, sx, sy, SIZE, SIZE);
            const tx = sx + SIZE + 8;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = 'bold 12px "Arial"';
            ctx.fillStyle = '#7ec8ff';
            const idText = `ID ${song.musicId}`;
            ctx.fillText(idText, tx, sy + 4, 160);
            // 新曲角标跟在 ID 右方(与 ID 同一行居中)
            if (song.isNew) drawNewSongBadge(ctx, tx + ctx.measureText(idText).width + 6, sy + 11);
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = '#FFF';
            ctx.fillText(song.title, tx, sy + 24, 200);
        }
        y += Math.ceil(event.songs.length / cols) * (SIZE + 10);
    }

    // ---- 3. 加成对象 ----
    const members = event.bonusCards.filter(c => c.kind === 'member');
    const supports = event.bonusCards.filter(c => c.kind === 'support');
    if (members.length || supports.length || event.bonusConditions.length) {
        y = section(ctx, y, `加成对象（${event.bonusCards.length} 张卡${event.bonusConditions.length ? ` · ${event.bonusConditions.length} 项条件` : ''}）`);
        // 左右分栏: 左=成员卡, 右=支援卡, 每边 3 个一行
        const rightX = MARGIN + BONUS_COL_W + BONUS_COL_GAP;
        const label = (cards: typeof members, x: number, name: string) => {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = cjkFontFamily(13);
            ctx.fillStyle = '#9aa4b2';
            ctx.fillText(name, x, y + 8);
            if (cards.length) {
                const b = cards[0].bonusByRank;
                ctx.fillStyle = '#ffd76e';
                ctx.fillText(`+${b[0].toFixed(1)}% ~ +${b[b.length - 1].toFixed(1)}%（按觉醒等级）`, x + 62, y + 8);
            }
        };
        label(members, MARGIN + 6, '成员卡');
        label(supports, rightX + 6, '支援卡');
        y += 18;
        const leftEnd = await drawCardGrid(ctx, server, members.map(c => ({ ref: c, bonus: c.bonusByRank })), MARGIN, y);
        const rightEnd = await drawCardGrid(ctx, server, supports.map(c => ({ ref: c, bonus: c.bonusByRank })), rightX, y);
        y = Math.max(leftEnd, rightEnd);
        // 分栏中线
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN + BONUS_COL_W + BONUS_COL_GAP / 2 + 0.5, y - cardRowHeight('member'));
        ctx.lineTo(MARGIN + BONUS_COL_W + BONUS_COL_GAP / 2 + 0.5, y - 4);
        ctx.stroke();

        // 条件加成: 同一条件只占一行, 成员/支援加成分两列
        if (event.bonusConditions.length) {
            y = divider(ctx, y);
            const colX = [MARGIN + 6, MARGIN + 300, MARGIN + 400];
            ctx.font = cjkFontFamily(12);
            ctx.fillStyle = '#9aa4b2';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText('条件加成', colX[0], y + 8);
            ctx.fillText('适用', colX[1], y + 8);
            ctx.fillText('成员加成', colX[2], y + 8);
            ctx.fillText('支援加成', colX[2] + 100, y + 8);
            y += 18;
            for (let i = 0; i < event.bonusConditions.length; i++) {
                const c = event.bonusConditions[i];
                ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.20)';
                ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 2);
                ctx.font = cjkFontFamily(13);
                ctx.fillStyle = '#FFF';
                ctx.fillText(c.label, colX[0], y + (ROW_H - 2) / 2, colX[1] - colX[0] - 12);
                // 适用: 两侧都有写「成员/支援」, 否则写单侧
                const both = c.member !== undefined && c.support !== undefined;
                ctx.fillStyle = '#9aa4b2';
                ctx.fillText(both ? '成员/支援' : (c.member !== undefined ? '成员' : '支援'), colX[1], y + (ROW_H - 2) / 2);
                ctx.fillStyle = '#ffd76e';
                ctx.fillText(c.member !== undefined ? `+${c.member.toFixed(1)}%` : '-', colX[2], y + (ROW_H - 2) / 2);
                ctx.fillText(c.support !== undefined ? `+${c.support.toFixed(1)}%` : '-', colX[2] + 100, y + (ROW_H - 2) / 2);
                y += ROW_H;
            }
        }
    }

    // ---- 4. 点数奖励: 每行 4 格, 每格 = pt + 奖励图标 + 数量 ----
    if (event.pointMilestones.length) {
        y = section(ctx, y, `点数奖励（${event.pointMilestones.length} 档）`);
        const colW = (WIDTH - MARGIN * 2) / MILESTONE_COLUMNS;
        for (let i = 0; i < event.pointMilestones.length; i++) {
            const m = event.pointMilestones[i];
            const x = MARGIN + (i % MILESTONE_COLUMNS) * colW;
            const my = y + Math.floor(i / MILESTONE_COLUMNS) * MILESTONE_H;
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.fillRect(x, my, colW - 8, MILESTONE_H - 4);
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'right';
            ctx.font = 'bold 11px "Arial"';
            ctx.fillStyle = '#8fd0ff';
            ctx.fillText(`${m.point.toLocaleString('en-US')}pt`, x + 44, my + (MILESTONE_H - 4) / 2);
            ctx.textAlign = 'left';
            let cx = x + 48;
            const shown = m.rewards.slice(0, 2);
            for (const item of shown) {
                await drawRewardChip(ctx, server, item, cx, my + 6, 16);
                cx += rewardChipWidth(ctx, item, 16);
            }
            if (m.rewards.length > shown.length) {
                ctx.font = cjkFontFamily(11);
                ctx.fillStyle = '#9aa4b2';
                ctx.fillText(`+${m.rewards.length - shown.length}`, cx + 1, my + (MILESTONE_H - 4) / 2);
            }
        }
        y += Math.ceil(event.pointMilestones.length / MILESTONE_COLUMNS) * MILESTONE_H + 4;
    }

    // ---- 5. 总奖励: 图标 + 数量, 左到右流式排列, 放不下就换行 ----
    if (event.totalRewards.length) {
        y = section(ctx, y, `总奖励（${event.totalRewards.length} 种）`);
        const ICON = 26;
        let cx = MARGIN;
        let ry = y;
        for (const item of event.totalRewards) {
            // 数量位数差别很大(×5 到 ×600,000), 固定格宽会互相压住, 所以按实际宽度排
            const w = rewardChipWidth(ctx, item, ICON);
            if (cx > MARGIN && cx + w > WIDTH - MARGIN) {
                cx = MARGIN;
                ry += 32;
            }
            await drawRewardChip(ctx, server, item, cx, ry + 2, ICON);
            cx += w;
        }
        y = ry + 32 + 4;
    }

    // ---- 6. 演出报酬 / 挑战演出报酬 ----
    const rewardTable = async (rows: typeof event.liveRewards, title: string): Promise<void> => {
        if (!rows.length) return;
        y = section(ctx, y, `${title}（${rows.length} 档）`);
        ctx.font = cjkFontFamily(12);
        ctx.fillStyle = '#9aa4b2';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        // 所有档并排在一行: 每格 = 得分评级(含门槛) + 活动点数 + 道具
        const perRow = Math.max(1, Math.floor((WIDTH - MARGIN * 2) / REWARD_ROW_CELL_W));
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const x = MARGIN + (i % perRow) * REWARD_ROW_CELL_W;
            const cy = y + Math.floor(i / perRow) * REWARD_ROW_CELL_H;
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.fillRect(x, cy, REWARD_ROW_CELL_W - 8, REWARD_ROW_CELL_H - 6);

            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 13px "Arial"';
            ctx.fillStyle = '#E6ECF5';
            ctx.fillText(SCORE_RANKS[row.scoreRank] ?? String(row.scoreRank), x + 6, cy + 11);
            ctx.font = '11px "Arial"';
            ctx.fillStyle = '#8a93a0';
            ctx.fillText(row.requiredScore !== undefined ? `(${compactScore(row.requiredScore)})` : '', x + 24, cy + 11, 54);

            ctx.font = '12px "Arial"';
            ctx.fillStyle = '#7ec8ff';
            ctx.fillText(row.points ? `${row.points.toLocaleString('en-US')} pt` : '-', x + 6, cy + 30, 62);

            let cx = x + 66;
            for (const item of row.items) {
                await drawRewardChip(ctx, server, item, cx, cy + 21, 16);
                cx += rewardChipWidth(ctx, item, 16);
            }
        }
        y += Math.ceil(rows.length / perRow) * REWARD_ROW_CELL_H + 4;
    };
    await rewardTable(event.liveRewards, '演出报酬');
    await rewardTable(event.challengeRewards, '挑战演出报酬');

    return y;
}

export async function drawEventRichDetail(server: Server, event: Event, compress: boolean): Promise<Array<Buffer | string>> {
    // 底图要先取回来: 顶图栏高度取决于它的原始宽高比(要完整显示, 不能裁)
    const bannerImg = await eventArtImage(event, 'background');
    const logoImg = await eventArtImage(event, 'logo');
    const bannerH = bannerHeightFor(bannerImg);

    // 相关卡池: 上游没有「活动→卡池」字段, 按 UP 卡重合 + 时间重叠推断(见 data/relations.ts)。
    // 量高那趟不传数据, 栏位高度单独加 —— 免得为了量高去下载缩图。
    const relatedGachas = toRelatedItems(await relatedGachasOfEvent(server, event.eventId));
    const relatedWidth = WIDTH - MARGIN * 2;
    const contentEnd = await renderContent(createCanvas(10, 10).getContext('2d'), server, event, bannerH, bannerImg, logoImg)
        + relatedSectionHeight(relatedWidth, relatedGachas.length);
    const height = contentEnd + MARGIN;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    // 背景按活动相关团选(和有歌曲/卡片详情一致)
    await drawBackground(ctx, WIDTH, height, { server, bandId: event.backgroundBandId() });
    drawTitle(ctx, WIDTH, '活动详情');

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
    ctx.fillStyle = '#8fd0ff';
    fillTextCentered(ctx, event.typeLabel(), hx, metaMidY, WIDTH - MARGIN - hx);

    const end = await renderContent(ctx, server, event, bannerH, bannerImg, logoImg);

    // ---- 相关卡池 ----
    await drawRelatedSection(ctx, MARGIN, end, relatedWidth, '相关卡池', relatedGachas, server);

    return [await outputFinalBuffer(canvas, compress)];
}
