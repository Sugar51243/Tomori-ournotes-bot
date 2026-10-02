/**
 * 活动榜线(各档分数)的历史记录。
 *
 * 上游**只有当前快照、没有历史**: 挑战曲榜固定返回前 100 名, 所以「第 N 名的分数」直接就是
 * 榜单里第 N 条记录的 score。要画随时间的折线, 只能自己按小时采样存下来(有数据库进数据库,
 * 没数据库退化为进程内存)。
 */

/** 需求里要求的档位; 实际支持哪些由数据决定(榜单只有前 100 → 1000/5000/10000 自动不适配) */
export const CUTOFF_TIERS = [1, 2, 3, 10, 100, 1000, 5000, 10000] as const;
export type CutoffTier = typeof CUTOFF_TIERS[number];

/** 一次采样的一个点: 某活动某曲某档在当时(整点桶)的分数 */
export interface CutoffSample {
    musicId: number;
    tier: CutoffTier;
    /** 采样时刻(毫秒, 取整点桶) */
    bucket: number;
    score: number;
}

/** 一条折线: 某曲某档的分数序列(时间升序) */
export interface CutoffSeries {
    musicId: number;
    tier: CutoffTier;
    points: Array<{ at: number; score: number }>;
}

/** 存储文档(数据库里的形态) */
export interface CutoffDoc {
    server: string;
    eventId: number;
    musicId: number;
    tier: number;
    /** 整点桶(毫秒) —— 同一小时内的多次采样只会更新同一条 */
    bucket: number;
    score: number;
}
