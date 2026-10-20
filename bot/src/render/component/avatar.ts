import { Image, SKRSContext2D, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { imageBuffer } from '../../upstream/adapter';
import { config } from '../../config';
import { roundedRectPath } from './draw';
import { FONT_STACK } from './fonts';
import { logger } from '../../logger';

/**
 * 头像来源白名单, 只放行两种:
 *  - QQ 头像: https + qlogo.cn 域(QQ 头像规范域);
 *  - 网页平台的账号头像: `/api/avatars/<内容哈希>.ext` 这种站内相对地址,
 *    拉取时拼到网页平台基址(WEB_PLATFORM_BASE)上。
 * 其余一律不拉取(避免 SSRF/内网探测), 由调用方画占位块。
 */
const WEB_AVATAR_PATH_RE = /^\/api\/avatars\/[a-f0-9]{40}\.(png|jpg|webp|gif)$/;

/** 把记录里存的头像地址解析成可拉取的绝对 URL; 来源不允许/格式非法返回 undefined */
export function resolveAvatarUrl(avatarUrl: string | undefined): string | undefined {
    if (!avatarUrl) return undefined;
    if (WEB_AVATAR_PATH_RE.test(avatarUrl)) return `${config.webPlatformBase}${avatarUrl}`;
    try {
        const u = new URL(avatarUrl);
        if (u.protocol === 'https:' && (u.hostname === 'qlogo.cn' || u.hostname.endsWith('.qlogo.cn'))) {
            return avatarUrl;
        }
    } catch {
        /* 不是合法 URL —— 当作不允许 */
    }
    return undefined;
}

export function isAllowedAvatar(url: string | undefined): url is string {
    return resolveAvatarUrl(url) !== undefined;
}

/**
 * 缓存键 = 用户 ID + 地址哈希。
 * 带地址哈希是因为网页账号头像是内容寻址的: 换头像 = 换地址 = 换缓存键, 机器人立刻取到新图;
 * QQ 头像地址不随内容变, 仍旧靠 TTL(7 天)过期刷新。用户 ID 要消毒 ——
 * 网页用户是 `web:12` 这种, 冒号在 Windows 上不能做文件名。
 */
function avatarCacheKey(userId: string, url: string): string {
    const safeId = userId.replace(/[^A-Za-z0-9_-]/g, '_');
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
    return `images/qqavatar/${safeId}-${hash}.png`;
}

/** 拉取头像(带磁盘缓存); 来源非法/取不到/解码失败一律返回 undefined */
export async function loadAvatar(avatarUrl: string | undefined, userId: string): Promise<Image | undefined> {
    const url = resolveAvatarUrl(avatarUrl);
    if (!url) return undefined;
    try {
        const buf = await imageBuffer(url, avatarCacheKey(userId, url));
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
    const img = await loadAvatar(avatarUrl, userId);
    if (!img) {
        drawAvatarPlaceholder(ctx, x, y, size, userId, name);
        return;
    }
    const scale = Math.min(size / img.width, size / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
}
