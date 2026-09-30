/**
 * 玩家档案(账号查询)。
 *
 * 两个来源返回同一套形状(都是 moenotes 的 protobuf JSON 投影, int64 一律为十进制字符串):
 * - 自建网关 moenotes-api: GET {MOENOTES_API_BASE}/v1/{server}/profile/{id}
 * - 站点公开接口:        GET {MOENOTES_SITE_BASE}/api/players/{server}/{id}
 *   —— 后者只对「在 StarMoe 已验证且设为公开」的账号有数据, 其余 404。
 */
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

export class PlayerNotFoundError extends Error {
    constructor(message = '该账号未公开或不存在') {
        super(message);
        this.name = 'PlayerNotFoundError';
    }
}

export class PlayerUnavailableError extends Error {
    constructor(message = '玩家数据源暂不可用') {
        super(message);
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
