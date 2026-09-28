import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Character } from '../types/Character';
import { imageBuffer, characterIconUrl, characterSpriteUrl } from '../data/assets';
import { drawTitle, drawDatablock, outputFinalBuffer, DrawBlockRow } from '../components/list';
import { drawBackground } from '../components/background';
import { wrapTextLines } from '../components/draw';
import { FONT_STACK } from '../components/fonts';

/**
 * 角色详情信息图: 尽量展开全部信息 ——
 * 头像、名称(短名/英文名)、乐队、担当、生日、星座、身高、学校/班级、声优、
 * 宣传语、应援色、喜欢的事物与食物、简介。
 * 右侧信息行分两列, 使文字块不高于左侧立绘块; 画布高度按内容实测裁切。
 */
const WIDTH = 720;
const MARGIN = 16;
const ICON_X = MARGIN, ICON_Y = 64, ICON_W = 170;
/** 立绘(多为竖版, 如 741×1389)按原始比例贴合: 框高由图片比例算出, 避免被压扁 */
const ICON_MIN_H = 170, ICON_MAX_H = 300;
const INFO_X = 204;
const COLUMN_GAP = 16;
const CJK = FONT_STACK;

/** 立绘框高度(按图片宽高比贴合, 限制在 [ICON_MIN_H, ICON_MAX_H]) */
function iconBoxHeight(ratio: number): number {
    return Math.round(Math.min(Math.max(ICON_W / ratio, ICON_MIN_H), ICON_MAX_H));
}

/** 信息行(按有无该字段取舍) */
function buildRows(character: Character): DrawBlockRow[] {
    const rows: [string, string][] = [
        ['乐队', `${character.bandName || '-'}${character.bandPart ? ' · ' + character.bandPart : ''}`],
        ['生日', `${character.birthdayMonth}月${character.birthdayDay}日`]
    ];
    if (character.constellation) rows.push(['星座', character.constellation]);
    if (character.height) rows.push(['身高', character.height]);
    if (character.school) rows.push(['学校', character.school]);
    if (character.schoolClass) rows.push(['班级', character.schoolClass]);
    if (character.voiceActor) rows.push(['声优', character.voiceActor]);
    rows.push(['ID', String(character.characterId)]);
    if (!character.playable) rows.push(['备注', '不可操作角色']);
    return rows.map(([key, text]) => ({ key, text }));
}

/**
 * 内容排版(不含立绘图片本体): 应援色条 → 右侧信息(分两列) → 底部宣传语/爱好/食物 → 简介。
 * 返回内容结束的 y, 供画布高度与绘制共用(同一段代码先跑在测量画布上即为预排版)。
 */
function renderContent(ctx: SKRSContext2D, character: Character, boxH: number): number {
    // ---- 立绘占位 + 应援色条(主色/副色) ----
    ctx.fillStyle = '#222';
    ctx.fillRect(ICON_X, ICON_Y, ICON_W, boxH);
    ctx.fillStyle = character.mainColorCode;
    ctx.fillRect(ICON_X, ICON_Y + boxH + 8, ICON_W / 2, 12);
    ctx.fillStyle = character.subColorCode;
    ctx.fillRect(ICON_X + ICON_W / 2, ICON_Y + boxH + 8, ICON_W / 2, 12);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeRect(ICON_X + 0.5, ICON_Y + boxH + 8.5, ICON_W - 1, 11);
    ctx.fillStyle = '#BBB';
    ctx.font = '12px "Arial"';
    ctx.textBaseline = 'top';
    ctx.fillText(`${character.mainColorCode}`, ICON_X, ICON_Y + boxH + 26, ICON_W);

    // ---- 右侧信息 ----
    const infoWidth = WIDTH - INFO_X - MARGIN;
    let y = ICON_Y;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = character.mainColorCode || '#FFF';
    ctx.font = `28px ${CJK}`;
    ctx.fillText(character.characterName, INFO_X, y, infoWidth);
    y += 36;
    // 短名 / 英文名
    ctx.fillStyle = '#9aa4b2';
    ctx.font = `15px ${CJK}`;
    const alt = [character.shortName, character.enName].filter(Boolean).join(' / ');
    if (alt) {
        ctx.fillText(alt, INFO_X, y, infoWidth);
        y += 24;
    }
    y += 4;

    // 信息行分两列, 避免文字块比左侧立绘更长
    const rows = buildRows(character);
    const colWidth = Math.floor((infoWidth - COLUMN_GAP) / 2);
    const split = Math.ceil(rows.length / 2);
    const leftEnd = drawDatablock(ctx, INFO_X, y, rows.slice(0, split), colWidth, { fontSize: 15 });
    const rightEnd = drawDatablock(ctx, INFO_X + colWidth + COLUMN_GAP, y, rows.slice(split), colWidth, { fontSize: 15 });
    y = Math.max(leftEnd, rightEnd);

    // ---- 底部: 宣传语 / 爱好 / 喜欢的食物 / 简介 ----
    let by = Math.max(y + 16, ICON_Y + boxH + 56);
    const bottomRows: DrawBlockRow[] = [];
    if (character.catchCopy) bottomRows.push({ key: '宣传语', text: character.catchCopy });
    if (character.hobby) bottomRows.push({ key: '爱好', text: character.hobby });
    if (character.favoriteFood) bottomRows.push({ key: '喜欢食物', text: character.favoriteFood });
    if (bottomRows.length) {
        by = drawDatablock(ctx, MARGIN, by, bottomRows, WIDTH - MARGIN * 2, { fontSize: 15 });
    }
    if (character.description && character.description !== character.row?.descriptionTextId) {
        ctx.fillStyle = '#3a5fa8';
        ctx.fillRect(MARGIN, by + 8, 4, 18);
        ctx.fillStyle = '#FFF';
        ctx.font = `bold 15px ${CJK}`;
        ctx.fillText('简介', MARGIN + 14, by + 9, 80);
        ctx.fillStyle = '#CFD8E3';
        ctx.font = `14px ${CJK}`;
        let dy = by + 34;
        for (const line of wrapTextLines(ctx, character.description, WIDTH - MARGIN * 2, 6)) {
            ctx.fillText(line, MARGIN, dy, WIDTH - MARGIN * 2);
            dy += 20;
        }
        by = dy;
    }
    return by;
}

export async function drawCharacterDetail(character: Character, compress: boolean): Promise<Array<Buffer | string>> {
    // 先取立绘(优先 sprite, 退回 face icon): 图片比例决定贴合框高度
    const sprite = await imageBuffer(characterSpriteUrl(character.characterId), `images/character/${character.characterId}_sprite.png`).catch(() => undefined);
    const icon = sprite ?? await imageBuffer(characterIconUrl(character.characterId), `images/character/${character.characterId}_icon.png`).catch(() => undefined);
    let portrait: Awaited<ReturnType<typeof loadImage>> | undefined;
    if (icon) {
        try {
            portrait = await loadImage(icon);
        } catch { /* 占位 */ }
    }
    const boxH = iconBoxHeight(portrait ? portrait.width / portrait.height : 1);

    // 先量后画: 同一段排版先跑在测量画布上, 取得内容高度后再建正式画布
    const HEIGHT = renderContent(createCanvas(10, 10).getContext('2d'), character, boxH) + MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    await drawBackground(ctx, WIDTH, HEIGHT, character.bandId);
    drawTitle(ctx, WIDTH, '角色详情');

    renderContent(ctx, character, boxH);
    // 立绘按原始比例贴合框内(不拉伸)
    if (portrait) {
        const scale = Math.min(ICON_W / portrait.width, boxH / portrait.height);
        const dw = portrait.width * scale, dh = portrait.height * scale;
        ctx.drawImage(portrait, ICON_X + (ICON_W - dw) / 2, ICON_Y + (boxH - dh) / 2, dw, dh);
    }

    return [await outputFinalBuffer(canvas, compress)];
}
