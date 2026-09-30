import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { flagUrl, flagCacheKey, imageBuffer } from '../data/assets';
import { Server, serverProfile } from '../types/Server';
import { cjkFontFamily } from './fonts';

/**
 * 服务器图标: bdon.moe 的圆形国旗 SVG(512x512)。
 * @napi-rs/canvas 的 loadImage 直接支持 SVG, 无需栅格化依赖; 拉取失败时退化为色块 + 服名首字。
 */

/** 各服回退色块的颜色(彼此差异明显, 便于黑白印刷也能区分) */
const FALLBACK_COLORS: Record<Server, string> = {
    tw: '#c8443c',
    jp: '#d0407a',
    kr: '#3f6fd0',
    en: '#3f9d7a'
};

export interface ServerIconSize {
    /** 图标边长(像素) */
    size: number;
}

/** 画一个服务器图标; 始终占据 size x size 的方格 */
export async function drawServerIcon(ctx: SKRSContext2D, x: number, y: number, server: Server, size = 18): Promise<void> {
    const profile = serverProfile(server);
    const buf = await imageBuffer(flagUrl(profile.flagFile), flagCacheKey(profile.flagFile)).catch(() => undefined);
    if (buf) {
        try {
            const img = await loadImage(buf);
            // 圆形裁剪, 与站点上的圆形国旗一致
            ctx.save();
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, x, y, size, size);
            ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2 - 0.5, 0, Math.PI * 2);
            ctx.stroke();
            return;
        } catch {
            /* 解码失败 -> 占位 */
        }
    }
    drawServerIconPlaceholder(ctx, x, y, server, size);
}

/** 占位: 圆角色块 + 服名首字 */
export function drawServerIconPlaceholder(ctx: SKRSContext2D, x: number, y: number, server: Server, size = 18): void {
    ctx.fillStyle = FALLBACK_COLORS[server] ?? '#666';
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFF';
    ctx.font = cjkFontFamily(Math.round(size * 0.62));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(serverProfile(server).displayName.slice(0, 1), x + size / 2, y + size / 2 + 1, size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

/** 内部用: 预渲染一张图标位图(供需要复用同一图标的场景) */
export async function renderServerIcon(server: Server, size: number): Promise<Buffer> {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    await drawServerIcon(ctx, 0, 0, server, size);
    return canvas.toBuffer('image/png');
}
