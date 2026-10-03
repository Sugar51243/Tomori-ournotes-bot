import { Image, SKRSContext2D, loadImage } from '@napi-rs/canvas';
import { imageBuffer } from '../../upstream/adapter';
import { roundedRectPath } from './draw';
import { FONT_STACK } from './fonts';
import { logger } from '../../logger';

/**
 * QQ 头像: 用户上报的外链, 只允许 https + qlogo.cn 域(QQ 头像规范域),
 * 其余一律不拉取(避免 SSRF/内网探测), 由调用方画占位块。
 */
export function isAllowedQqAvatar(url: string | undefined): url is string {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'qlogo.cn' || u.hostname.endsWith('.qlogo.cn'));
    } catch {
        return false;
    }
}

/** 拉取头像(带磁盘缓存); 域名非法/取不到/解码失败一律返回 undefined */
export async function loadQqAvatar(avatarUrl: string | undefined, userId: string): Promise<Image | undefined> {
    if (!isAllowedQqAvatar(avatarUrl)) return undefined;
    try {
        const buf = await imageBuffer(avatarUrl, `images/qqavatar/${userId}.png`);
        if (!buf) return undefined;
        return await loadImage(buf);
    } catch (e) {
        logger('avatar', `load failed for ${userId}: ${e}`);
        return undefined;
    }
}

/** 头像占位: 按 userId 取确定性颜色 + 名字首字符 */
export function drawAvatarPlaceholder(ctx: SKRSContext2D, x: number, y: number, size: number, userId: string, name: string): void {
    let hash = 0;
    for (const ch of userId) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
    ctx.fillStyle = `hsl(${hash}, 42%, 42%)`;
    roundedRectPath(ctx, x, y, size, size, Math.round(size * 0.18));
    ctx.fill();
    const initial = [...(name || userId)][0] ?? '?';
    ctx.fillStyle = '#FFF';
    ctx.font = `${Math.round(size * 0.5)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, x + size / 2, y + size / 2 + 1, size - 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

/** 头像绘制(有图则按原始比例居中贴合, 无图或失败则画占位) */
export async function drawAvatar(ctx: SKRSContext2D, x: number, y: number, size: number, userId: string, name: string, avatarUrl?: string): Promise<void> {
    const img = await loadQqAvatar(avatarUrl, userId);
    if (!img) {
        drawAvatarPlaceholder(ctx, x, y, size, userId, name);
        return;
    }
    const scale = Math.min(size / img.width, size / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
}
