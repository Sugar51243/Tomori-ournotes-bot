import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Gacha, formatGameDate, zoneLabel } from '../../../features/types/Gacha';
import { getGachaRates } from '../../../features/gacha/simulate';
import { imageBuffer, gachaBannerUrl } from '../../../upstream/adapter';
import { drawTitle, drawDatablock, outputFinalBuffer } from '../../component/list';
import { drawBackground } from '../../component/background';
import { wrapTextLines } from '../../component/draw';
import { drawCardSections, cardSectionsHeight, CARD_LIST_WIDTH, CARD_LIST_MARGIN } from '../card/cardList';
import { isMemberCard } from '../../../search/search';
import { relatedEventsOfGacha } from '../../../db/adapter';
import { drawRelatedSection, relatedSectionHeight, toRelatedItems } from '../relatedSection';
import { FONT_STACK } from '../../component/fonts';

/**
 * 卡池详情信息图:
 * 横幅、名称、说明、期间(按区域时区)、状态、招募券、真实出货率, 以及 **PICK UP 对象** ——
 * 复用卡片列表的分区格式(角色卡 3:4 两列 / 留影 16:9 通栏), 不拉伸图片。
 */
const WIDTH = CARD_LIST_WIDTH;
const MARGIN = CARD_LIST_MARGIN;
/** 横幅高度上限(原图约 420×180, 按比例贴合后居中, 不拉伸) */
const BANNER_MAX_H = 240;
const CJK = FONT_STACK;

export async function drawGachaDetail(gacha: Gacha, compress: boolean): Promise<Array<Buffer | string>> {
    const pickUps = gacha.pickUpCards;
    const sectionsHeight = pickUps.length ? 44 + cardSectionsHeight(pickUps) : 0;
    const contentWidth = WIDTH - MARGIN * 2;
    // 相关活动: 上游没有「卡池→活动」字段, 按 UP 卡重合 + 时间重叠推断(见 src/db/relations.ts)
    const relatedEvents = toRelatedItems(await relatedEventsOfGacha(gacha.server, gacha.gachaId));
    const relatedHeight = relatedSectionHeight(contentWidth, relatedEvents.length);

    // ---- 横幅: 先取图确定贴合尺寸(排版与画布高度都依赖它) ----
    let banner: Awaited<ReturnType<typeof loadImage>> | undefined;
    if (gacha.bannerAssetName) {
        const buf = await imageBuffer(gachaBannerUrl(gacha.server, gacha.bannerAssetName), `images/gacha/${gacha.server}/${gacha.gachaId}_banner.webp`).catch(() => undefined);
        if (buf) {
            try {
                banner = await loadImage(buf);
            } catch { /* 占位 */ }
        }
    }
    const bannerScale = banner ? Math.min(contentWidth / banner.width, BANNER_MAX_H / banner.height) : 0;
    const bannerW = banner ? banner.width * bannerScale : 0;
    const bannerH = banner ? banner.height * bannerScale : 0;

    // ---- 期间 / 状态 / 券 / 出货率 ----
    const rows: [string, string][] = [
        ['开始', gacha.startAt ? `${formatGameDate(gacha.startAt, gacha.server)} (${zoneLabel(gacha.server)})` : '-'],
        ['结束', gacha.endAt ? `${formatGameDate(gacha.endAt, gacha.server)} (${zoneLabel(gacha.server)})` : '-'],
        ['状态', `${gacha.isOpen() ? '开放中' : '已结束'}${gacha.isLimited ? ' · 限定' : ''}${gacha.isNewMember ? ' · 新成员' : ''}`]
    ];
    if (gacha.ticketName) rows.push(['招募券', gacha.ticketName]);
    const rates = await getGachaRates(gacha);
    if (rates) {
        const rarityLabel: Record<string, string> = { '4': 'SSR', '3': 'SR', '2': 'R', item: '道具' };
        rows.push(['出货率', Object.entries(rates).filter(([, v]) => v > 0).map(([k, v]) => `${rarityLabel[k] ?? k} ${v}%`).join(' / ')]);
    }
    rows.push(['ID', String(gacha.gachaId)]);
    const blockRows = rows.map(([key, text]) => ({ key, text }));

    // ---- 先量后画: 名称/说明/信息行高度用测量画布算出, 画布高度按内容裁切 ----
    const probe = createCanvas(10, 10).getContext('2d');
    let contentEnd = 56 + (bannerH ? bannerH + 12 : 0);
    probe.font = `24px ${CJK}`;
    contentEnd += wrapTextLines(probe, gacha.gachaName, contentWidth, 2).length * 30;
    if (gacha.description) {
        probe.font = `14px ${CJK}`;
        contentEnd += wrapTextLines(probe, gacha.description, contentWidth, 3).length * 19;
    }
    contentEnd = drawDatablock(probe, MARGIN, contentEnd + 10, blockRows, contentWidth, { fontSize: 15 });

    const HEIGHT = contentEnd + sectionsHeight + relatedHeight + MARGIN;
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, HEIGHT);
    drawTitle(ctx, WIDTH, '卡池详情');

    // ---- 横幅 ----
    let y = 56;
    if (banner) {
        ctx.drawImage(banner, MARGIN + (contentWidth - bannerW) / 2, y, bannerW, bannerH);
        y += bannerH + 12;
    }

    // ---- 名称 + 说明 ----
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#FFF';
    ctx.font = `24px ${CJK}`;
    for (const line of wrapTextLines(ctx, gacha.gachaName, WIDTH - MARGIN * 2, 2)) {
        ctx.fillText(line, MARGIN, y, WIDTH - MARGIN * 2);
        y += 30;
    }
    if (gacha.description) {
        ctx.fillStyle = '#CFD8E3';
        ctx.font = `14px ${CJK}`;
        for (const line of wrapTextLines(ctx, gacha.description, contentWidth, 3)) {
            ctx.fillText(line, MARGIN, y, contentWidth);
            y += 19;
        }
    }
    y += 10;

    // ---- 期间 / 状态 / 券 / 出货率 ----
    y = drawDatablock(ctx, MARGIN, y, blockRows, contentWidth, { fontSize: 15 });

    // ---- PICK UP 对象(卡片列表同款分区) ----
    if (pickUps.length) {
        ctx.fillStyle = '#e0367a';
        ctx.fillRect(MARGIN, y + 12, 4, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = `bold 18px ${CJK}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(`PICK UP（${pickUps.length}）`, MARGIN + 14, y + 22);
        const pickUpIds = new Set(pickUps.map(c => (isMemberCard(c) ? c.cardId : c.supportCardId)));
        await drawCardSections(ctx, pickUps, y + 44, pickUpIds);
    }

    // ---- 相关活动 ----
    await drawRelatedSection(ctx, MARGIN, y + sectionsHeight, contentWidth, '相关活动', relatedEvents, gacha.server);

    return [await outputFinalBuffer(canvas, compress)];
}
