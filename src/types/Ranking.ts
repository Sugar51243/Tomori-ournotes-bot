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
}

export interface MusicRanking {
    server: string;
    musicId: number;
    entries: RankingEntry[];
    /** 上游返回的更新时间(X-Fetched-At, 毫秒) */
    fetchedAt?: number;
}

/** 分数千分位(如 9,543,025) */
export function formatScore(score: number): string {
    return score.toLocaleString('en-US');
}
