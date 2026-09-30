import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cardTypeColors } from '../types/Card';
import { imageBuffer, cardThumbUrl, supportCardThumbUrl } from '../data/assets';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground, commonBandId } from '../components/background';
import { wrapTextLines } from '../components/draw';
import { AnyCard, isMemberCard } from '../search';
import { SupportCard } from '../types/SupportCard';
import { FONT_STACK } from '../components/fonts';
import { Server } from '../types/Server';

/**
 * 卡片分区展示(卡片列表 / 卡池 PICK UP 共用):
 * - 角色卡(成员卡): 2 张一层, 缩略图为 3:4 竖版(384x512)
 * - 支援卡(留影): 1 张一层(通栏), 缩略图为 16:9 横版(512x288)
 * 两类缩略图比例不同, 各自按其原始比例绘制, 不做拉伸。
 */
const WIDTH = 1000;
const MARGIN = 16;
const HEADER_H = 56;
const SECTION_H = 34;

const MEMBER_COLUMNS = 2;
const MEMBER_CELL_W = Math.floor((WIDTH - MARGIN * (MEMBER_COLUMNS + 1)) / MEMBER_COLUMNS);
const MEMBER_CELL_H = 176;
const MEMBER_THUMB_H = 152;                       // 3:4 -> 114x152
const MEMBER_THUMB_W = Math.round(MEMBER_THUMB_H * 0.75);

const SUPPORT_CELL_W = WIDTH - MARGIN * 2;
const SUPPORT_CELL_H = 140;
const SUPPORT_THUMB_H = 126;                      // 16:9 -> 224x126
const SUPPORT_THUMB_W = Math.round(SUPPORT_THUMB_H * 16 / 9);

const rarityColors: Record<number, number | string> = { 2: '#7ec8ff', 3: '#ffd76e', 4: '#ff9de2' };

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

async function loadThumb(card: AnyCard): Promise<{ img?: Awaited<ReturnType<typeof loadImage>>; w: number; h: number }> {
    const member = isMemberCard(card);
    const w = member ? MEMBER_THUMB_W : SUPPORT_THUMB_W;
    const h = member ? MEMBER_THUMB_H : SUPPORT_THUMB_H;
    if (!card.assetId) return { w, h };
    const url = member ? cardThumbUrl(card.server, card.cardId) : supportCardThumbUrl(card.server, card.assetId);
    const key = member ? `images/card/${card.assetId}_thumb.png` : `images/support/${card.assetId}_thumb.png`;
    const buf = await imageBuffer(url, key);
    if (!buf) return { w, h };
    try {
        return { img: await loadImage(buf), w, h };
    } catch {
        return { w, h };
    }
}

/** 缩略图按原始比例贴合框内(不拉伸; 源图比例与框一致时即为满框) */
function drawThumb(ctx: Ctx, img: Awaited<ReturnType<typeof loadImage>>, x: number, y: number, w: number, h: number): void {
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 区块标题条 */
function drawSectionHeader(ctx: Ctx, y: number, text: string, color: string): void {
    ctx.fillStyle = color;
    ctx.fillRect(MARGIN, y, 4, 20);
    ctx.fillStyle = '#FFF';
    ctx.font = `bold 17px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, MARGIN + 14, y + 10);
}

/** 卡片左上角的 ID 徽章 */
function drawIdBadge(ctx: Ctx, x: number, y: number, id: number): void {
    ctx.fillStyle = '#1f1e33';
    ctx.fillRect(x, y, 64, 20);
    ctx.fillStyle = '#FFF';
    ctx.font = '14px "Arial"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), x + 32, y + 10, 60);
}

/** 稀有度 + 种类标签(可选 UP 标记) */
function drawBadges(ctx: Ctx, x: number, y: number, rarityLabel: string, typeLabel: string, typeColor: string, pickUp = false): void {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#FFF';
    ctx.font = `bold 18px ${FONT_STACK}`;
    ctx.fillText(rarityLabel, x, y);
    const rarityW = ctx.measureText(rarityLabel).width;
    ctx.fillStyle = typeColor;
    ctx.fillRect(x + rarityW + 8, y + 1, 52, 20);
    ctx.fillStyle = '#FFF';
    ctx.font = `12px ${FONT_STACK}`;
    ctx.fillText(typeLabel, x + rarityW + 13, y + 5, 44);
    if (pickUp) {
        ctx.fillStyle = '#e0367a';
        ctx.fillRect(x + rarityW + 68, y + 1, 40, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 12px "Arial"';
        ctx.fillText('UP', x + rarityW + 74, y + 5, 30);
    }
}

/** 分区高度(供调用方预先计算画布高度) */
export function cardSectionsHeight(cards: AnyCard[]): number {
    const members = cards.filter(isMemberCard);
    const supports = cards.filter(c => !isMemberCard(c));
    const memberRows = Math.ceil(members.length / MEMBER_COLUMNS);
    return (members.length ? SECTION_H + memberRows * (MEMBER_CELL_H + 12) : 0)
        + (supports.length ? SECTION_H + supports.length * (SUPPORT_CELL_H + 12) : 0);
}

/** 绘制卡片分区(角色卡区 + 支援卡区), 返回绘制结束的 y 坐标 */
export async function drawCardSections(ctx: Ctx, cards: AnyCard[], startY: number, pickUpIds?: Set<number>): Promise<number> {
    const members = cards.filter(isMemberCard);
    const supports = cards.filter((c): c is SupportCard => !isMemberCard(c));
    let y = startY;

    // ---- 角色卡区(2 张一层) ----
    if (members.length) {
        drawSectionHeader(ctx, y, `角色卡（${members.length}）`, '#3a5fa8');
        y += SECTION_H;
        for (let i = 0; i < members.length; i++) {
            const card = members[i];
            const col = i % MEMBER_COLUMNS;
            const row = Math.floor(i / MEMBER_COLUMNS);
            const x = MARGIN + col * (MEMBER_CELL_W + MARGIN);
            const cy = y + row * (MEMBER_CELL_H + 12);

            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(x, cy, MEMBER_CELL_W, MEMBER_CELL_H);
            const { img, w, h } = await loadThumb(card);
            const thumbX = x + 10, thumbY = cy + 12;
            ctx.fillStyle = '#222';
            ctx.fillRect(thumbX, thumbY, w, h);
            if (img) drawThumb(ctx, img, thumbX, thumbY, w, h);
            drawIdBadge(ctx, thumbX, thumbY, card.cardId);

            const tx = thumbX + w + 12;
            const tw = MEMBER_CELL_W - (tx - x) - 10;
            drawBadges(ctx, tx, cy + 14, card.rarityLabel(), '角色卡', '#3a5fa8', pickUpIds?.has(card.cardId));
            let ty = cy + 44;
            ctx.fillStyle = '#FFF';
            ctx.font = `18px ${FONT_STACK}`;
            for (const line of wrapTextLines(ctx, card.cardName, tw, 2)) {
                ctx.fillText(line, tx, ty, tw);
                ty += 24;
            }
            ctx.fillStyle = cardTypeColors[card.cardType] ?? '#888';
            ctx.fillRect(tx, ty + 2, 48, 20);
            ctx.fillStyle = '#FFF';
            ctx.font = `12px ${FONT_STACK}`;
            ctx.fillText(card.attribute, tx + 5, ty + 6, 40);
            ctx.fillStyle = '#BBB';
            ctx.font = `14px ${FONT_STACK}`;
            ctx.fillText(card.characterName, tx + 64, ty + 6, tw - 64);
        }
        y += Math.ceil(members.length / MEMBER_COLUMNS) * (MEMBER_CELL_H + 12);
    }

    // ---- 支援卡区(1 张一层) ----
    if (supports.length) {
        drawSectionHeader(ctx, y, `支援卡（${supports.length}）`, '#6a4fa8');
        y += SECTION_H;
        for (let i = 0; i < supports.length; i++) {
            const card = supports[i];
            const cy = y + i * (SUPPORT_CELL_H + 12);
            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(MARGIN, cy, SUPPORT_CELL_W, SUPPORT_CELL_H);
            const { img, w, h } = await loadThumb(card);
            const thumbX = MARGIN + 10, thumbY = cy + 7;
            ctx.fillStyle = '#222';
            ctx.fillRect(thumbX, thumbY, w, h);
            if (img) drawThumb(ctx, img, thumbX, thumbY, w, h);
            drawIdBadge(ctx, thumbX, thumbY, card.supportCardId);

            const tx = thumbX + w + 16;
            const tw = SUPPORT_CELL_W - (tx - MARGIN) - 12;
            drawBadges(ctx, tx, cy + 14, card.rarityLabel(), '支援卡', '#6a4fa8', pickUpIds?.has(card.supportCardId));
            let ty = cy + 44;
            ctx.fillStyle = '#FFF';
            ctx.font = `20px ${FONT_STACK}`;
            for (const line of wrapTextLines(ctx, card.cardName, tw, 2)) {
                ctx.fillText(line, tx, ty, tw);
                ty += 26;
            }
            ctx.fillStyle = cardTypeColors[card.cardType] ?? '#888';
            ctx.fillRect(tx, cy + SUPPORT_CELL_H - 34, 48, 20);
            ctx.fillStyle = '#FFF';
            ctx.font = `12px ${FONT_STACK}`;
            ctx.fillText(card.attribute, tx + 5, cy + SUPPORT_CELL_H - 30, 40);
            ctx.fillStyle = '#BBB';
            ctx.font = `14px ${FONT_STACK}`;
            ctx.fillText(card.characterNames.join('、'), tx + 64, cy + SUPPORT_CELL_H - 30, tw - 64);
        }
        y += supports.length * (SUPPORT_CELL_H + 12);
    }

    return y;
}

/** 卡片搜索列表图 */
export async function drawCardList(server: Server, cards: AnyCard[], compress: boolean): Promise<Array<Buffer | string>> {
    const height = HEADER_H + cardSectionsHeight(cards) + MARGIN;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    // 结果全部同属一个乐队时用该乐队背景, 混合结果用 other 背景
    await drawBackground(ctx, WIDTH, height, { server, bandId: commonBandId(cards.map(c => c.bandId)) });
    const members = cards.filter(isMemberCard);
    const supports = cards.filter(c => !isMemberCard(c));
    const summary = [
        `共 ${cards.length} 张卡片`,
        members.length ? `角色卡 ${members.length}` : '',
        supports.length ? `支援卡 ${supports.length}` : ''
    ].filter(Boolean).join(' · ');
    drawTitle(ctx, WIDTH, summary);

    await drawCardSections(ctx, cards, HEADER_H);
    return [await outputFinalBuffer(canvas, compress)];
}

// 供卡池等场景复用的尺寸常量
export const CARD_LIST_WIDTH = WIDTH;
export const CARD_LIST_MARGIN = MARGIN;
export const CARD_LIST_HEADER_H = HEADER_H;
export { rarityColors as cardRarityColors };
