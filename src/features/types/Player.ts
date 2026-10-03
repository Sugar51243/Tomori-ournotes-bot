/**
 * 玩家档案(账号查询)。
 *
 * 两个来源返回同一套形状(都是 moenotes 的 protobuf JSON 投影, int64 一律为十进制字符串):
 * - 自建网关 moenotes-api: GET {MOENOTES_API_BASE}/v1/{server}/profile/{id}
 * - 站点公开接口:        GET {MOENOTES_SITE_BASE}/api/players/{server}/{id}
 *   —— 只要「在站点添加并验证了游戏账号、且把个人主页设为公开」的账号才有数据, 其余一律 404。
 *   查询失败时的提示统一引导用户去 ACCOUNT_BIND_URL 绑定并公开(见下)。
 */

/** 站点账号页: 添加/验证游戏账号、把个人主页设为公开都在这里 */
export const ACCOUNT_BIND_URL = 'https://bdon.moe/account';
export interface PlayerProfile {
    server: string;
    profileId: string;
    name: string;
    /** 等级(仅站点/网关的完整档案有, 排行数据里没有) */
    level?: number;
    /** 经验值(int64, 十进制字符串) */
    rankExp?: string;
    totalFavorite?: number;
    /** 最爱成员卡 id(用于从自有素材源取卡面大图) */
    favoriteCardId?: number;
    /** 玩家自己设计的 profile card 缩略图(港澳台服常为空) */
    profileCardUrls: string[];
    /** 上游取数时间(毫秒) */
    fetchedAt?: number;
}

/** 数据源: 自建网关能查任意玩家, 站点公开接口只能查「已绑定且已公开」的账号 */
export type PlayerSource = 'gateway' | 'site';

/** 玩家不存在(上游明确回答没有这个账号) */
export class PlayerNotFoundError extends Error {
    /**
     * 站点路径查不到时**优先**给出「去站点绑定并公开」的指引 —— 这是现在查不到的最主要原因;
     * 自建网关能查任意玩家, 它还查不到就说明 ID 确实不存在, 不该再让人去绑定。
     */
    constructor(source: PlayerSource = 'site') {
        super(source === 'gateway'
            ? '该账号不存在'
            : `查询不到该账号。请先到 ${ACCOUNT_BIND_URL} 添加并验证游戏账号，再把个人主页设为「公开」（公开后任何拿到链接的人都能查看）`);
        this.name = 'PlayerNotFoundError';
    }
}

/** 玩家档案暂不可用(网络/网关故障), 稍后可重试 */
export class PlayerUnavailableError extends Error {
    constructor(message = '玩家数据源暂不可用', source: PlayerSource = 'site') {
        const hint = source === 'gateway'
            ? '请检查自建网关是否在运行、MOENOTES_API_BASE / MOENOTES_API_KEY 是否正确'
            : `若持续失败，请到 ${ACCOUNT_BIND_URL} 确认游戏账号已添加、已验证且个人主页已公开`;
        super(`${message}；${hint}`);
        this.name = 'PlayerUnavailableError';
    }
}

/**
 * 按 ID 首位推断区域(moenotes-api 的规则): 2 -> tw, 3 -> en, 4 -> kr。
 * JP 没有前缀规则(接受任意正整数 ID), 必须显式指定 server。
 */
export function inferServerFromPlayerId(playerId: string): 'tw' | 'en' | 'kr' | undefined {
    switch (playerId[0]) {
        case '2': return 'tw';
        case '3': return 'en';
        case '4': return 'kr';
        default: return undefined;
    }
}

/** 各服的合法玩家 ID 形状(取自 moenotes src/config/players.ts) */
export function isValidPlayerId(server: string, playerId: string): boolean {
    if (server === 'jp') return /^[1-9]\d{0,18}$/.test(playerId);
    if (server === 'tw') return /^2\d{10}$/.test(playerId);
    if (server === 'en') return /^3\d{10}$/.test(playerId);
    if (server === 'kr') return /^4\d{10}$/.test(playerId);
    return /^\d{1,19}$/.test(playerId);
}
