/**
 * 域常量。这些值必须与 bot / web 保持一致(它们写进数据库与上游用的就是这些),
 * 原样搬自 web/server/src/constants.ts 与 bot 的 src/features/types/Server.ts。
 */

export const SERVER_LIST = ['tw', 'jp', 'kr', 'en'] as const;
export type Server = (typeof SERVER_LIST)[number];

/** 与 bot 的 normalizeServer 同义: 大小写/空白不敏感, hk 与 hk-tw-mo 都归到 tw */
const SERVER_ALIASES: Record<string, Server> = {
    tw: 'tw',
    jp: 'jp',
    kr: 'kr',
    en: 'en',
    hk: 'tw',
    'hk-tw-mo': 'tw',
};

export function normalizeServer(value: unknown): Server | undefined {
    if (typeof value !== 'string') return undefined;
    return SERVER_ALIASES[value.trim().toLowerCase()];
}

export function isServer(value: unknown): value is Server {
    return normalizeServer(value) !== undefined;
}

/** bot 支持的榜线档位; 实际可用的档位由数据决定(上游每曲榜只有前 100 名) */
export const CUTOFF_TIERS = [1, 2, 3, 10, 100, 1000, 5000, 10000] as const;
export type CutoffTier = (typeof CUTOFF_TIERS)[number];

export function isCutoffTier(value: unknown): value is CutoffTier {
    return typeof value === 'number' && (CUTOFF_TIERS as readonly number[]).includes(value);
}

/** 账号角色。与数据库 ENUM 的字符串值一一对应 */
export const ROLES = ['user', 'admin_low', 'admin_high'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** 论坛帖子/评论的排序白名单(合法值即 SQL 片段, 见 forum repo) */
export const POST_SORTS = ['new', 'hot', 'top'] as const;
export type PostSort = (typeof POST_SORTS)[number];

/** 自制谱列表排序白名单 */
export const CHART_SORTS = ['id', 'latest', 'notes'] as const;
export type ChartSort = (typeof CHART_SORTS)[number];
