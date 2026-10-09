/**
 * 歌曲排行(取自 rankd /api/v1/{server}/music/{musicId}/ranking)。
 * 上游每首歌返回前 100 名, 含玩家档案与最高分卡组; 这里只保留出图需要的字段。
 */
export interface RankingEntry {
    /** 名次, 从 1 开始 */
    rank: number;
    score: number;
    playerId: string;
    playerName: string;
    /** 最高分卡组的队长卡 id(可能缺省) */
    cardId?: string;
    /** 最高分卡组综合力(上游 highScoreDeck.totalPower; 上游缺省时为 undefined) */
    deckPower?: number;
}

export interface MusicRanking {
    server: string;
    musicId: number;
    entries: RankingEntry[];
    /** 上游返回的更新时间(X-Fetched-At, 毫秒) */
    fetchedAt?: number;
    /** 实际供数的数据源档案名(如 'bdon.moe' / 'haneoka.org'); 出图标注「数据来源」用 */
    origin?: string;
}

/** 分数千分位(如 9,543,025) */
export function formatScore(score: number): string {
    return score.toLocaleString('en-US');
}

/** 前三名奖牌色(歌曲排行 / 活动榜线共用) */
export const RANK_COLORS = ['#ffd76e', '#cfd8e3', '#e0a06a'];
