/**
 * 谱面效率数据(music-data.json 的裁剪版, 站点「歌曲meta」同源)。
 *
 * 得分模型(与站点一致, 实测数值对得上):
 *   期望得分 P 点综合力打一首歌 = P × (base + Σ_k 技能槽_k平均加成 × W_k)
 *   - base:  模型综合力(30 万)下、理论最佳游玩的全曲得分 ÷ 模型综合力, 按种子平均
 *   - W_k:   第 k 个技能槽放一个 +100% 普通加分技能时整局多得的分数 ÷ 综合力, 按种子平均
 *   - 击奏live 用 seeds(激走开, 全区间 1 名), 自由live 用 offSeeds(激走关)
 *   效率(分/综合力/分钟) = 上式 ÷ ((BGM 时长 + 结算耗时) / 60000)
 */

/** 评级门槛(按歌定义, 各难度共用; 击奏/自由两套门槛) */
export interface MusicDataScoreRank {
    rank: 'D' | 'C' | 'B' | 'A' | 'S' | 'SS';
    /** 自由live(单人)门槛 */
    requiredScore?: number;
    /** 击奏live(房间全员之和)门槛 */
    battleRequiredScore?: number;
}

export interface MusicDataChartStat {
    musicId: number;
    scoreId: number;
    difficulty: 'easy' | 'normal' | 'hard' | 'expert';
    /** 游戏内显示的等级(可能带小数) */
    displayLevel: number;
    /** 判定音符数(全连连击数) */
    notes: number;
    /** 主 BPM */
    bpmMain: number;
    /** BGM 时长(ms) */
    bgmMs: number;
    /** 击奏live 无法游玩(第 4 个 Fever 起游戏会出错) —— 不进击奏榜, 自由榜不受影响 */
    unplayable: boolean;
    /** 击奏live(激走开)的得分模型 */
    battle?: { base: number; weights: number[] };
    /** 自由live(激走关)的得分模型 */
    free?: { base: number; weights: number[] };
    /** 各评级门槛(D~SS) */
    scoreRanks: MusicDataScoreRank[];
}

export interface MusicData {
    format: string;
    charts: MusicDataChartStat[];
    /** 模型综合力(得分基准) */
    power: number;
    /** 实际供数的数据源档案名(如 'bdon.moe' / 'haneoka.org'); 出图标注「数据来源」用 */
    origin?: string;
    /**
     * 降级数据: 没有任何技能权重(种子模型缺席, 来自备用源的替代模型, 如 haneoka 的「乐曲分析」)。
     * 效率榜照常可用(权重为空 = 技能不影响出分), 但**评级门槛也没有** ——
     * 依赖门槛/权重的消费方(活动推荐曲、网页组卡器)必须拒绝降级数据。
     */
    degraded?: boolean;
}

/** 榜单上的一行: 谱面 + 算好的效率值与站点那套派生值(后者只算不画) */
export interface EfficiencyRow extends MusicDataChartStat {
    /** 分/综合力(= 出分) */
    rate: number;
    /** 分/综合力/分钟(= 效率, 排序依据) */
    perMinute: number;
    /** 该谱面在当前场景下的基础系数(无技能时的 分/综合力) */
    base: number;
    /** 该谱面 ΣW(支配比较用) */
    sumW: number;
    /** 相对: 该行效率 ÷ 榜首效率(1 = 与榜首持平) */
    relative: number;
    /** 被多少张谱面支配(技能 0~150% 下两轴都不差于它); 0 = 在帕累托前沿上 */
    dominatedBy: number;
    /** 前沿: 没有被任何谱面支配 */
    frontier: boolean;
}

/**
 * 活动推荐曲的一行。
 *
 * 数据有两个来源: music-data 的谱面模拟(完整), 或**借来的**数据(新曲还没进 music-data 时,
 * 用游戏 masterdata 的门槛分 + 谱面站的定数/物量/BPM/时长凑一行)—— 后者的
 * 「分/综合力」无从取得, 所以 need / rate 缺失, 出图显示「—」。
 */
export interface RecommendRow {
    musicId: number;
    difficulty: MusicDataChartStat['difficulty'];
    displayLevel: number;
    notes: number;
    /** 主 BPM */
    bpmMain: number;
    /** BGM 时长(ms); 借不到时为 undefined */
    bgmMs?: number;
    /** 目标评级 */
    targetRank: MusicDataScoreRank['rank'];
    /** 该评级的门槛分(按场景取单人/房间门槛); 借不到时为 undefined */
    threshold?: number;
    /** 所需综合力 = 门槛 ÷ 分/综合力; 无模拟数据时为 undefined */
    need?: number;
    /** 局/小时 = 3600s ÷ (BGM 时长 + 结算耗时); BGM 时长未知时为 undefined */
    perHour?: number;
    /** 数据来源: 模拟数据 / 借自 masterdata+谱面站 */
    source: 'musicdata' | 'borrowed';
}
