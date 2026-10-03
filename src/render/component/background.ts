import { loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { imageBuffer, backgroundUrl, assetCacheKey } from '../../upstream/adapter';
import { Server, defaultServer } from '../../features/types/Server';

/**
 * 结果背景图: 按搜索结果归属(乐队)选择官方背景图, 叠加暗色蒙版保证文字可读。
 * 除谱面预览外, 所有出图接口均使用此背景。
 */
const BAND_BACKGROUNDS: Record<number, string> = {
    1: 'bg_adv_0103',   // MyGO!!!!!
    2: 'bg_adv_0202',   // Ave Mujica
    3: 'bg_adv_0301',   // 梦限大MewType
    4: 'bg_adv_0401',   // millsage
    5: 'bg_adv_0503'    // 一家Dumb Rock!
};
const FALLBACK_BACKGROUND = 'OfflineBonusBackground';

/** 乐队 id -> 背景图名称(未知/无归属时用 offline 背景) */
export function backgroundNameForBand(bandId?: number): string {
    return (bandId !== undefined && BAND_BACKGROUNDS[bandId]) || FALLBACK_BACKGROUND;
}

/** 从一组结果中取统一的乐队 id(全部同属一个乐队时才有值, 否则视为混合 -> other) */
export function commonBandId(bandIds: (number | undefined)[]): number | undefined {
    const unique = [...new Set(bandIds.filter((b): b is number => !!b))];
    return unique.length === 1 ? unique[0] : undefined;
}

/**
 * 绘制背景:
 * - 等比放大铺满画布(scale = max(画布宽/图宽, 画布高/图高)), 居中后按画布裁剪
 *   —— 竖屏画布(高>宽)时即"等比放大 + 取中间 + 截取", 不拉伸变形
 * - 叠加自上而下的暗色蒙版, 保证前景文字可读
 * - 背景图获取失败时退化为纯黑底
 */
export async function drawBackground(
    ctx: SKRSContext2D,
    width: number,
    height: number,
    opts: { server?: Server; bandId?: number; scrimAlpha?: number } = {}
): Promise<void> {
    const { server = defaultServer(), bandId, scrimAlpha = 0.62 } = opts;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const name = backgroundNameForBand(bandId);
    const buf = await imageBuffer(backgroundUrl(server, name), assetCacheKey(server, `background/${name}.webp`)).catch(() => undefined);
    if (buf) {
        try {
            const img = await loadImage(buf);
            const scale = Math.max(width / img.width, height / img.height);
            const dw = img.width * scale;
            const dh = img.height * scale;
            ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
        } catch {
            /* 解码失败: 保持黑底 */
        }
    }

    const grd = ctx.createLinearGradient(0, 0, 0, height);
    grd.addColorStop(0, `rgba(0, 0, 0, ${scrimAlpha})`);
    grd.addColorStop(1, `rgba(0, 0, 0, ${Math.min(0.95, scrimAlpha + 0.16)})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, width, height);
}
