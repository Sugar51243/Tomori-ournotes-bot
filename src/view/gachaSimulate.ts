import { createCanvas, loadImage, Image } from '@napi-rs/canvas';
import { GachaDrawResult } from '../gacha/simulate';
import { imageBuffer, cardThumbUrl, supportCardThumbUrl, itemIconUrl } from '../data/assets';
import { drawTitle, outputFinalBuffer } from '../components/list';
import { drawBackground } from '../components/background';
import { rarityNames } from '../types/Card';
import { FONT_STACK } from '../components/fonts';

const ICON_SIZE = 210;
const MARGIN = 16;
const rarityColors: Record<number, string> = { 2: '#7ec8ff', 3: '#ffd76e', 4: '#ff9de2' };

interface DrawVisual {
    /** 汇总分组键 */
    key: string;
    label: string;
    sub: string;
    rarity: number;
    image?: Image;
    isItem: boolean;
}

async function safeLoad(buf: Buffer): Promise<Image | undefined> {
    try {
        return await loadImage(buf);
    } catch {
        return undefined;
    }
}

async function loadVisual(result: GachaDrawResult): Promise<DrawVisual> {
    if (result.kind === 'member' && result.card) {
        const buf = await imageBuffer(cardThumbUrl(result.card.server, result.card.cardId), `images/card/${result.card.server}/${result.card.cardId}_thumb.png`);
        return {
            key: `member:${result.card.cardId}`,
            label: result.card.cardName,
            sub: result.card.characterName,
            rarity: result.rarity,
            image: buf ? await safeLoad(buf) : undefined,
            isItem: false
        };
    }
    if (result.kind === 'support' && result.supportCard) {
        const buf = await imageBuffer(supportCardThumbUrl(result.supportCard.server, result.supportCard.assetId), `images/support/${result.supportCard.server}/${result.supportCard.assetId}_thumb.png`);
        return {
            key: `support:${result.supportCard.supportCardId}`,
            label: result.supportCard.cardName,
            sub: '支援卡',
            rarity: result.rarity,
            image: buf ? await safeLoad(buf) : undefined,
            isItem: false
        };
    }
    const item = result.item;
    const buf = item?.imagePath ? await imageBuffer(itemIconUrl(item.server, item.imagePath), `images/item/${item.server}/${item.itemId}.webp`) : undefined;
    return {
        key: `item:${item?.itemId ?? 0}`,
        label: item?.itemName ?? '道具',
        sub: result.itemAmount ? `×${result.itemAmount}` : '',
        rarity: 0,
        image: buf ? await safeLoad(buf) : undefined,
        isItem: true
    };
}

/**
 * 抽卡结果图:
 * - <=10 抽: 逐个展示(成员卡/支援卡用卡面缩略图, 道具用图标)
 * - >10 抽: 按资源汇总计数, 稀有度降序
 */
export async function drawGachaSimulate(gachaName: string, results: GachaDrawResult[], compress: boolean): Promise<Array<Buffer | string>> {
    if (results.length <= 10) {
        // 排布同游戏十连: 每行至多 5 张(≤5 抽只排一行), 避免出成 2000+ px 宽的长条
        const columns = Math.min(results.length, 5);
        const rows = Math.ceil(results.length / columns);
        const cellW = ICON_SIZE + 8;
        const cellH = ICON_SIZE + 46;
        const width = MARGIN * 2 + columns * cellW;
        const height = 56 + rows * cellH + (rows - 1) * 8 + MARGIN;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        await drawBackground(ctx, width, height);
        drawTitle(ctx, width, `${gachaName} ×${results.length}`);

        for (let i = 0; i < results.length; i++) {
            const visual = await loadVisual(results[i]);
            const x = MARGIN + (i % columns) * cellW;
            const y = 56 + Math.floor(i / columns) * (cellH + 8);
            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(x, y, ICON_SIZE, ICON_SIZE);
            if (visual.image) {
                const ratio = visual.image.width / visual.image.height;
                const drawW = ratio >= 1 ? ICON_SIZE : ICON_SIZE * ratio;
                const drawH = ratio >= 1 ? ICON_SIZE / ratio : ICON_SIZE;
                ctx.drawImage(visual.image, x + (ICON_SIZE - drawW) / 2, y + (ICON_SIZE - drawH) / 2, drawW, drawH);
            }
            // 稀有度角标
            const badgeColor = visual.isItem ? '#C9A227' : (rarityColors[visual.rarity] ?? '#888');
            const badgeText = visual.isItem ? 'ITEM' : (rarityNames[visual.rarity] ?? `${visual.rarity}★`);
            ctx.fillStyle = badgeColor;
            ctx.fillRect(x, y, 52, 24);
            ctx.fillStyle = '#000';
            ctx.font = `bold 14px ${FONT_STACK}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(badgeText, x + 26, y + 12, 52);
            // UP 标记
            if (results[i].pickUp) {
                ctx.fillStyle = '#E0367A';
                ctx.fillRect(x + ICON_SIZE - 44, y, 44, 24);
                ctx.fillStyle = '#FFF';
                ctx.fillText('UP', x + ICON_SIZE - 22, y + 12, 44);
            }
            // 名称
            ctx.fillStyle = '#FFF';
            ctx.font = `13px ${FONT_STACK}`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(visual.label, x, y + ICON_SIZE + 6, ICON_SIZE);
            ctx.fillStyle = '#AAA';
            ctx.font = `12px ${FONT_STACK}`;
            ctx.fillText(visual.sub, x, y + ICON_SIZE + 24, ICON_SIZE);
        }
        return [await outputFinalBuffer(canvas, compress)];
    }

    // 汇总模式
    const grouped = new Map<string, { visual: DrawVisual; count: number; rarity: number; pickUp: boolean }>();
    const cache = new Map<string, DrawVisual>();
    for (const r of results) {
        const key = r.kind === 'member' ? `member:${r.card?.cardId}`
            : r.kind === 'support' ? `support:${r.supportCard?.supportCardId}`
                : `item:${r.item?.itemId}`;
        let entry = grouped.get(key);
        if (!entry) {
            let visual = cache.get(key);
            if (!visual) {
                visual = await loadVisual(r);
                cache.set(key, visual);
            }
            entry = { visual, count: 0, rarity: r.rarity, pickUp: r.pickUp };
            grouped.set(key, entry);
        }
        entry.count++;
    }
    const entries = [...grouped.values()].sort((a, b) => b.rarity - a.rarity || b.count - a.count);

    // 单列行式(卡名完整可读), 行数过多时按每图 ROWS_PER_IMAGE 行拆成多张图返回
    const ROW_H = 96;
    const ROWS_PER_IMAGE = 24;
    const width = 660;
    const pages: typeof entries[] = [];
    for (let i = 0; i < entries.length; i += ROWS_PER_IMAGE) {
        pages.push(entries.slice(i, i + ROWS_PER_IMAGE));
    }

    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        const page = pages[p];
        const height = 56 + 16 + page.length * ROW_H + MARGIN;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        await drawBackground(ctx, width, height);
        const pageLabel = pages.length > 1 ? ` (汇总 ${p + 1}/${pages.length})` : ' (汇总)';
        drawTitle(ctx, width, `${gachaName} ×${results.length}${pageLabel}`);

        for (let i = 0; i < page.length; i++) {
            const { visual, count, rarity, pickUp } = page[i];
            const y = 56 + 16 + i * ROW_H;
            ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
            ctx.fillRect(8, y, width - 16, ROW_H - 8);
            ctx.fillStyle = '#222';
            ctx.fillRect(16, y + 6, 78, 78);
            if (visual.image) {
                const ratio = visual.image.width / visual.image.height;
                const drawW = ratio >= 1 ? 78 : 78 * ratio;
                const drawH = ratio >= 1 ? 78 / ratio : 78;
                ctx.drawImage(visual.image, 16 + (78 - drawW) / 2, y + 6 + (78 - drawH) / 2, drawW, drawH);
            }
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const badgeColor = visual.isItem ? '#C9A227' : (rarityColors[rarity] ?? '#888');
            ctx.fillStyle = badgeColor;
            ctx.font = `bold 18px ${FONT_STACK}`;
            ctx.fillText(visual.isItem ? 'ITEM' : (rarityNames[rarity] ?? `${rarity}★`), 108, y + 14);
            ctx.fillStyle = '#FFF';
            ctx.font = `17px ${FONT_STACK}`;
            ctx.fillText(visual.label, 160, y + 14, 320);
            ctx.fillStyle = '#AAA';
            ctx.font = `13px ${FONT_STACK}`;
            ctx.fillText(visual.sub, 108, y + 46, 400);
            if (pickUp) {
                ctx.fillStyle = '#E0367A';
                ctx.fillRect(width - 190, y + 14, 44, 22);
                ctx.fillStyle = '#FFF';
                ctx.font = 'bold 13px "Arial"';
                ctx.textAlign = 'center';
                ctx.fillText('UP', width - 168, y + 25, 44);
                ctx.textAlign = 'left';
            }
            ctx.fillStyle = '#1f1e33';
            ctx.fillRect(width - 130, y + 14, 108, 42);
            ctx.fillStyle = '#FFF';
            ctx.font = 'bold 22px "Arial"';
            ctx.textAlign = 'center';
            ctx.fillText(`×${count}`, width - 76, y + 35, 108);
            ctx.textAlign = 'left';
        }

        buffers.push(await outputFinalBuffer(canvas, compress));
    }

    return buffers;
}
