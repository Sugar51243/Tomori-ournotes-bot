import { config } from '../config';

/**
 * 外链图片白名单。
 *
 * 公告横幅来自游戏自己的 CDN, 国旗来自 bdon.moe 站点 —— 都是客户端可控之外的第三方地址。
 * 逐条拉取前必须校验, 否则构造出的任意 URL(name/asset 之类来自上游 JSON)会变成 SSRF 探针。
 * 与 components/avatar.ts 里 isAllowedQqAvatar 的思路一致: 只放行 https + 明确的域后缀。
 */

const ALLOWED_HOST_SUFFIXES = [
    // 游戏 CDN(公告横幅): 港澳台服 / 韩服 / 国际服 / 日服
    'gamerfusiontech.com',
    'bilibiligame.net',
    'bang-dream-on.jp'
];

export function isAllowedExternalImage(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();

    // 自家站点(国旗、占位图)始终放行
    try {
        if (host === new URL(config.moenotesSiteBase).hostname.toLowerCase()) return true;
    } catch {
        /* 配置非法时忽略 */
    }
    return ALLOWED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
