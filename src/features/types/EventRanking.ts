/**
 * 活动榜线(上游 rankd 的活动追踪接口, 与站点活动追踪器 bdon.moe/events/tracker 同源:
 * `/api/v1/{server}/events/current` + `/api/v1/{server}/events/{id}` +
 * `/api/v1/{server}/events/{id}/challenges/{challengeMusicId}/ranking`)。
 *
 * 每个挑战曲各自带一个「最后取数时间」, 出图的「最后更新 / 已更新多久」就取自这里。
 * 排行接口自身的时间在响应头 X-Fetched-At 里, 磁盘缓存拿不到响应头 —— 但它的 ETag 末段就是
 * 该时间的 base36, 由 src/upstream/ranking/client.ts 解出(见 ChallengeRanking.fetchedAt)。
 */

/** 活动内在榜的一首乐曲(上游 challengeRankings 的裁剪版) */
export interface EventRankingSong {
    /** 曲目 id(展示用: 封面/曲名/乐团都按它查 masterdata) */
    musicId: number;
    /** 挑战曲 id(取榜用); 非挑战型活动没有, 退回按 musicId 取普通歌曲榜 */
    challengeMusicId?: number;
    /** 上游该曲榜最后一次取数时间(ms epoch); 非上游追踪来源时为 undefined */
    lastFetchedAt?: number;
    /** 上游标记该榜数据陈旧 */
    stale?: boolean;
    /** 上游正在刷新该榜 */
    refreshing?: boolean;
}

/** 一个活动的榜单追踪信息 */
export interface EventRankingTrack {
    eventId: number;
    eventType: number;
    songs: EventRankingSong[];
    /** true = 来自上游追踪(带更新时间); false = 由 masterdata 兜底 */
    tracked: boolean;
    /**
     * 上游给的活动阶段(已按上游自带的 endAt 纠偏, 见 types/EventPhase.ts);
     * 上游缺字段时为 undefined —— 调用方按「未知」保守处理, 不要当成已结束。
     */
    phase?: import('./EventPhase').EventPhase;
}

/** 单个挑战曲的榜(上游错误时带 kind, 供出图说明原因) */
export interface ChallengeRanking {
    entries: import('./Ranking').RankingEntry[];
    /** 上游错误种类: not_found / challenge_not_started / challenge_ranking_disabled / challenge_not_collected / pending / upstream ... */
    errorKind?: string;
    /** 该榜数据的上游更新时间(ms epoch, 数据源钩子或 ETag 解出; 解不出时为 undefined) */
    fetchedAt?: number;
    /** 实际供数的数据源档案名(如 'bdon.moe' / 'haneoka.org'); 出图标注「数据来源」用 */
    origin?: string;
}
