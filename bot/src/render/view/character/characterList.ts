import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Character } from '../../../features/types/Character';
import { imageBuffer, characterIconUrl } from '../../../upstream/adapter';
import { drawTitle, outputFinalBuffer } from '../../component/list';
import { drawBackground, commonBandId } from '../../component/background';
import { FONT_STACK } from '../../component/fonts';
import { Server } from '../../../features/types/Server';

const COL_COUNT = 3;
const CARD_W = 300;
const CARD_H = 90;
const MARGIN = 16;

/** 角色搜索列表图 */
export async function drawCharacterList(server: Server, characters: Character[], compress: boolean): Promise<Array<Buffer | string>> {
    const rows = Math.ceil(characters.length / COL_COUNT);
    const width = MARGIN + COL_COUNT * (CARD_W + MARGIN);
    const height = 56 + rows * (CARD_H + MARGIN) + MARGIN;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 结果全部同属一个乐队时用该乐队背景, 混合结果用 other 背景
    await drawBackground(ctx, width, height, { server, bandId: commonBandId(characters.map(c => c.bandId)) });
    drawTitle(ctx, width, `共 ${characters.length} 名角色`);

    for (let i = 0; i < characters.length; i++) {
        const c = characters[i];
        const col = i % COL_COUNT;
        const row = Math.floor(i / COL_COUNT);
        const x = MARGIN + col * (CARD_W + MARGIN);
        const y = 56 + row * (CARD_H + MARGIN);

        ctx.fillStyle = 'rgba(18, 18, 30, 0.72)';
        ctx.fillRect(x, y, CARD_W, CARD_H);
        ctx.fillStyle = '#222';
        ctx.fillRect(x + 8, y + 8, 74, 74);
        const icon = await imageBuffer(characterIconUrl(c.server, c.characterId), `images/character/${c.server}/${c.characterId}_icon.png`);
        if (icon) {
            try {
                ctx.drawImage(await loadImage(icon), x + 8, y + 8, 74, 74);
            } catch { /* 占位 */ }
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = c.mainColorCode || '#FFF';
        ctx.font = `18px ${FONT_STACK}`;
        ctx.fillText(c.characterName, x + 96, y + 16, CARD_W - 104);
        ctx.fillStyle = '#BBB';
        ctx.font = `14px ${FONT_STACK}`;
        ctx.fillText(`${c.bandName}${c.bandPart ? ' · ' + c.bandPart : ''}`, x + 96, y + 46, CARD_W - 104);
    }

    return [await outputFinalBuffer(canvas, compress)];
}
