import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cardTypeColors } from '../../types/Card';
import { imageBuffer, cardFullArtUrl, supportCardFullUrl } from '../../data/assets';
import { drawTitle, outputFinalBuffer } from '../../components/list';
import { drawBackground } from '../../components/background';
import { wrapTextLines } from '../../components/draw';
import { drawMultiServerTable, multiServerTableHeight } from '../../components/multiServerTable';
import { ServerRow } from '../../data/serverInfo';
import { AnyCard, isMemberCard } from '../../search';
import { formatGameDateUTC8 } from '../../types/Gacha';
import { SkillInfo } from '../../data/skills';
import { relatedForCard } from '../../data/relations';
import { keywordsForEntity } from '../../data/keywords';
import { drawKeywordSection, keywordSectionHeight } from '../keywordSection';
import { drawRelatedSection, relatedSectionHeight, toRelatedItems } from '../relatedSection';
import { FONT_STACK } from '../../components/fonts';

/**
 * 卡片详情信息图(角色卡/支援卡通用): 尽量展开全部信息 ——
 * 卡面、稀有度、属性、名称、角色、四维数值、实装日期、等级上限, 以及各技能(名称 + 按最高等级套值的描述)。
 * 两种卡的卡面比例不同, 各按原始比例排版:
 * - 角色卡: 3:4 竖版卡面左置, 信息区在右侧
 * - 支援卡: 16:9 横版卡面通栏置顶, 信息区在卡面下方
 * 四维口径也不同: 角色卡为绝对数值, 支援卡为百分比(主数据值 ÷100)。
 */
const WIDTH = 720;
const MARGIN = 16;
const ART_X = MARGIN, ART_Y = 64;
/** 角色卡卡面: 宽固定 240, 高度按原始比例(3:4 → 320), 上限 ART_MAX_H */
const ART_MAX_W = 240, ART_MAX_H = 440;
const SUPPORT_ART_W = WIDTH - MARGIN * 2;
const SUPPORT_ART_H = Math.round(SUPPORT_ART_W * 9 / 16);
const INFO_X = 280;
const SKILL_DESC_MAX_LINES = 4;

const rarityColors: Record<number, string> = { 2: '#7ec8ff', 3: '#ffd76e', 4: '#ff9de2' , 10: '#44aaff'};
const CJK = FONT_STACK;

interface SkillBlock { skill: SkillInfo; label: string; lines: string[]; }

function skillLabel(skill: SkillInfo): string {
    if (skill.label) return skill.label;
    switch (skill.kind) {
        case 'leader': return '队长技能';
        case 'live': return '演出技能';
        case 'gekisou': return '击奏技能';
        default: return '技能';
    }
}

function buildSkillBlocks(card: AnyCard, member: boolean): SkillBlock[] {
    const measure = createCanvas(10, 10).getContext('2d');
    measure.font = `14px ${CJK}`;
    return card.skills.map((skill, i) => {
        const lines: string[] = [];
        for (const rawLine of skill.description.split('\n')) {
            for (const wrapped of wrapTextLines(measure, rawLine, WIDTH - 72, SKILL_DESC_MAX_LINES)) {
                lines.push(wrapped);
                if (lines.length >= SKILL_DESC_MAX_LINES) break;
            }
            if (lines.length >= SKILL_DESC_MAX_LINES) break;
        }
        return { skill, label: skillLabel(skill), lines };
    });
}

/** 支援卡四维为百分比口径(主数据值 ÷100), 角色卡为绝对数值 */
function powerText(value: number, member: boolean): string {
    return member ? String(value) : `${(value / 100).toFixed(2)}%`;
}

/** 信息行(两种卡的字段与口径不同) */
function buildRows(card: AnyCard): [string, string][] {
    if (isMemberCard(card)) {
        return [
            ['角色', card.characterName || '-'],
            ['副标题', card.subtitle || '-'],
            ['综合力', powerText(card.totalPower(), true)],
            ['演出', powerText(card.performancePowerMax, true)],
            ['技巧', powerText(card.technicPowerMax, true)],
            ['视觉', powerText(card.visualPowerMax, true)],
            ['等级上限', card.maxLevel ? `Lv${card.maxLevel}` : '-'],
            ['实装', formatGameDateUTC8(card.startAt, card.server)],
            ['ID', String(card.cardId)]
        ];
    }
    return [
        ['角色', card.characterNames.join('、') || '-'],
        ['综合力', powerText(card.totalPower(), false)],
        ['演出', powerText(card.performancePowerMax, false)],
        ['技巧', powerText(card.technicPowerMax, false)],
        ['视觉', powerText(card.visualPowerMax, false)],
        ['等级上限', card.maxLevel ? `Lv${card.maxLevel}` : '-'],
        ['实装', formatGameDateUTC8(card.startAt, card.server)],
        ['ID', String(card.supportCardId)]
    ];
}

/** 卡面图(角色卡 3:4 / 支援卡 16:9); 取不到时返回 undefined, 由调用方画占位块 */
async function loadArt(card: AnyCard): Promise<Awaited<ReturnType<typeof loadImage>> | undefined> {
    if (!card.assetId) return undefined;
    const url = isMemberCard(card) ? cardFullArtUrl(card.server, card.cardId) : supportCardFullUrl(card.server, card.assetId);
    const key = isMemberCard(card) ? `images/card/${card.assetId}_full.png` : `images/support/${card.assetId}_full.png`;
    const buf = await imageBuffer(url, key);
    if (!buf) return undefined;
    try {
        return await loadImage(buf);
    } catch {
        return undefined;
    }
}

export async function drawCardDetail(card: AnyCard, rows: ServerRow[], compress: boolean): Promise<Array<Buffer | string>> {
    const member = isMemberCard(card);
    const blocks = buildSkillBlocks(card, member);
    const infoRows = buildRows(card);

    // 相关卡池 / 相关活动 / 用户关键词(取数区域与页面主体一致): 没有则整块跳过
    const entityId = member ? card.cardId : card.supportCardId;
    const related = await relatedForCard(card.server, member ? 'member' : 'support', entityId);
    const relatedGachas = toRelatedItems(related.gachas);
    const relatedEvents = toRelatedItems(related.events);
    const keywords = await keywordsForEntity(member ? 'card' : 'supportCard', entityId);

    // 卡面: 先取图并按原始比例算贴合尺寸 —— 卡面不再铺占位背景, 排版高度也随实际卡面收缩
    const art = await loadArt(card);
    const artMaxW = member ? ART_MAX_W : SUPPORT_ART_W;
    const artMaxH = member ? ART_MAX_H : SUPPORT_ART_H;
    const artScale = art ? Math.min(artMaxW / art.width, artMaxH / art.height) : 0;
    const artW = art ? art.width * artScale : artMaxW;
    const artH = art ? art.height * artScale : artMaxH;

    // 信息区位置随卡面比例变化(支援卡卡面通栏置顶, 信息区落在卡面下方)
    const infoLeft = member ? INFO_X : MARGIN;
    const infoWidth = member ? WIDTH - INFO_X - 16 : WIDTH - MARGIN * 2;
    const infoTop = member ? ART_Y : ART_Y + artH + 18;

    // 先量后画: 卡名/简介的换行结果与信息区高度先行算定, 画布高度与绘制共用同一组结果
    const measure = createCanvas(10, 10).getContext('2d');
    measure.font = `24px ${CJK}`;
    const nameLines = wrapTextLines(measure, card.cardName, infoWidth, 2);
    measure.font = `14px ${CJK}`;
    const descLines = !member && card.description ? wrapTextLines(measure, card.description, infoWidth, 4) : [];
    const infoHeight = 36 + nameLines.length * 30 + 4 + infoRows.length * 22
        + (descLines.length ? 6 + descLines.length * 19 : 0);

    const SKILLS_Y = Math.max(ART_Y + artH, infoTop + infoHeight) + 18;
    const skillsHeight = blocks.length
        ? 34 + blocks.reduce((h, b) => h + 24 + b.lines.length * 17 + 10, 0)
        : 0;
    // 各服信息块(单图多服: 每服一行, 行首国旗)
    const multiHeight = rows.length ? multiServerTableHeight(rows.length) + 34 : 0;
    // 关联栏位通栏(不受角色卡右侧信息区的窄宽度限制)
    const relatedWidth = WIDTH - MARGIN * 2;
    const relatedHeight = relatedSectionHeight(relatedWidth, relatedGachas.length)
        + relatedSectionHeight(relatedWidth, relatedEvents.length)
        + keywordSectionHeight(measure, keywords, relatedWidth);
    const HEIGHT = SKILLS_Y + skillsHeight + multiHeight + relatedHeight + 16;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, HEIGHT, { server: card.server, bandId: card.bandId });
    drawTitle(ctx, WIDTH, member ? '角色卡详情' : '支援卡详情');

    if (art) {
        ctx.drawImage(art, ART_X + (artMaxW - artW) / 2, ART_Y, artW, artH);
    } else {
        ctx.fillStyle = '#222';
        ctx.fillRect(ART_X, ART_Y, artMaxW, artMaxH);
    }

    // ---- 信息区 ----
    let y = infoTop;
    ctx.textAlign = 'left';
    // 稀有度与种类/属性标签同一行居中对齐(标签块占 y+4..y+26, 中心 y+15)
    // 用字形实际上下界做视觉居中: CJK 字体的 em 盒比西文字形高, 直接 baseline=middle 会偏低
    ctx.fillStyle = rarityColors[card.rarity] ?? '#888';
    ctx.font = `bold 22px ${CJK}`;
    ctx.textBaseline = 'alphabetic';
    const rarityText = card.rarityLabel();
    const rarityMetrics = ctx.measureText(rarityText);
    const rarityBaseline = y + 15 + (rarityMetrics.actualBoundingBoxAscent - rarityMetrics.actualBoundingBoxDescent) / 2;
    ctx.fillText(rarityText, infoLeft, rarityBaseline);
    const rarityW = rarityMetrics.width;
    ctx.textBaseline = 'top';
    // 种类标签
    ctx.fillStyle = member ? '#3a5fa8' : '#6a4fa8';
    ctx.fillRect(infoLeft + rarityW + 10, y + 4, 56, 22);
    ctx.fillStyle = '#FFF';
    ctx.font = `13px ${CJK}`;
    ctx.fillText(member ? '角色卡' : '支援卡', infoLeft + rarityW + 16, y + 9, 48);
    // 属性标签
    const attrW = infoLeft + rarityW + 80;
    ctx.fillStyle = cardTypeColors[card.cardType] ?? '#888';
    ctx.fillRect(attrW, y + 4, 52, 22);
    ctx.fillStyle = '#FFF';
    ctx.font = `13px ${CJK}`;
    ctx.fillText(card.attribute, attrW + 6, y + 9, 40);
    y += 36;

    // 卡名
    ctx.fillStyle = '#FFF';
    ctx.font = `24px ${CJK}`;
    for (const line of nameLines) {
        ctx.fillText(line, infoLeft, y, infoWidth);
        y += 30;
    }
    y += 4;

    // 信息行
    ctx.font = `15px ${CJK}`;
    for (const [key, value] of infoRows) {
        ctx.fillStyle = '#9aa4b2';
        ctx.fillText(`${key}`, infoLeft, y);
        ctx.fillStyle = '#FFF';
        ctx.fillText(value, infoLeft + 76, y, infoWidth - 76);
        y += 22;
    }
    // 支援卡简介
    if (descLines.length) {
        y += 6;
        ctx.fillStyle = '#9aa4b2';
        ctx.font = `14px ${CJK}`;
        for (const line of descLines) {
            ctx.fillText(line, infoLeft, y, infoWidth);
            y += 19;
        }
    }

    // ---- 技能区 ----
    if (blocks.length) {
        ctx.fillStyle = '#3a5fa8';
        ctx.fillRect(16, SKILLS_Y, 4, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = `bold 17px ${CJK}`;
        ctx.fillText(`技能（${blocks.length}）`, 30, SKILLS_Y + 1, 300);

        let sy = SKILLS_Y + 34;
        for (const block of blocks) {
            ctx.fillStyle = '#7ec8ff';
            ctx.font = `bold 15px ${CJK}`;
            ctx.fillText(block.label, 24, sy, 116);
            ctx.fillStyle = '#FFF';
            ctx.fillText(block.skill.name, 148, sy, WIDTH - 250);
            ctx.fillStyle = '#9aa4b2';
            ctx.font = '13px "Arial"';
            ctx.fillText(`Lv${block.skill.maxLevel}`, WIDTH - 76, sy + 1, 60);
            sy += 24;
            ctx.fillStyle = '#CFD8E3';
            ctx.font = `14px ${CJK}`;
            if (block.lines.length === 0) {
                ctx.fillText('（无描述）', 36, sy);
                sy += 17;
            }
            for (const line of block.lines) {
                ctx.fillText(line, 36, sy, WIDTH - 72);
                sy += 17;
            }
            sy += 10;
        }
    }

    // ---- 各服信息 ----
    let afterMulti = SKILLS_Y + skillsHeight;
    if (rows.length) {
        const my = SKILLS_Y + skillsHeight + 18;
        ctx.fillStyle = '#3a5fa8';
        ctx.fillRect(16, my, 4, 20);
        ctx.fillStyle = '#FFF';
        ctx.font = `bold 17px ${CJK}`;
        ctx.textBaseline = 'middle';
        ctx.fillText('各服信息', 30, my + 10);
        afterMulti = await drawMultiServerTable(ctx, 16, my + 26, WIDTH - 32, rows);
    }

    // ---- 关键词 / 相关卡池 / 相关活动 ----
    let ry = drawKeywordSection(ctx, MARGIN, afterMulti, relatedWidth, keywords);
    ry = await drawRelatedSection(ctx, MARGIN, ry, relatedWidth, '相关卡池', relatedGachas, card.server);
    await drawRelatedSection(ctx, MARGIN, ry, relatedWidth, '相关活动', relatedEvents, card.server);

    return [await outputFinalBuffer(canvas, compress)];
}
