/**
 * ⚠ 移植自 web/client/src/accountPackage/types.ts（网页组卡器）—— **保持同逻辑**：
 * 两边任何一边改了算法，另一边要同步（bot 侧 scripts/verify-deck-port.ts 用同一份样例
 * 数据对照数值）。除 import 来源与下方补充的类型别名外，不要改动运算本体 ——
 * 尤其是 bp（×10000）与 f32(Math.fround) 的往返，那是照游戏客户端舍入逐步对齐的。
 */
import type { Server } from '../features/types/Server';

/** 与 web 侧同名的地区短码别名（bot 的 Server 就是这四个值） */
export type ServerKey = Server;

/** 卡片明细 [masterId, 等级, 特训次数, 觉醒次数, Live技能, 演出技能]（与 web 的 types/api.ts 一致） */
export type MemberCardEntry = [number, number, number, number, number, number];
/** 留影卡 [masterId, 等级, 限界突破] */
export type SupportCardEntry = [number, number, number];
/** 角色 [masterId, 等级] */
export type CharacterEntry = [number, number];

export interface GameAccountCardsData {
    members: MemberCardEntry[];
    supports: SupportCardEntry[];
    characters: CharacterEntry[];
}

export interface GameAccountItemsData {
    items: Array<[number, number]>;
    bandItems: Array<[number, number]>;
}


/** 解析/换算过程中用户能看懂的错 */
export class PackageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PackageError';
    }
}

/**
 * 这个客户端认识的 bundle 格式版本。
 *
 * 请求时会把它当查询参数发给服务端, 服务端对不上就明确报错 —— 免得改过一次字段布局之后,
 * 旧客户端拿到读不懂的数据, 在换算里静默算出些看似正常、其实错位的结果。
 * 顺带它还充当缓存键的一部分: 以后再加版本, 浏览器里那些旧副本自然就用不上了。
 */
export const BUNDLE_FORMAT = 4;

/** 三维参数 rate [performance, technic, visual]，单位 10000 = 100% */
export type RateTriple = [number, number, number];

/** 队长技能效果：[leaderSkillId, level, skillEffectType, effectValue, …目标id] */
export type LeaderSkillEffectRow = number[];

/**
 * 成员卡：[id, assetID, 名idx, 副标题idx, characterId, rarity, cardType,
 *         等级组, 特训组, 觉醒组, pMax, tMax, vMax, 标签[], leaderSkillID, liveSkillID]
 */
export type MemberCardTuple = [
    number, number, number, number, number, number, number, number, number, number, number, number, number, number[], number, number,
];
/** 留影卡：[id, assetID, 名idx, rarity, cardType, 等级组, 突破组, pMax, tMax, vMax, 角色id[]] */
export type SupportCardTuple = [number, number, number, number, number, number, number, number, number, number, number[]];

/**
 * 服务端下发的主数据 bundle(见 web/server/src/upstream/masterBundle.ts)。
 * 全是紧凑数组, 下标指向文本池 `t`; -1 表示无。
 */
export interface MasterBundle {
    fmt: number;
    server: ServerKey;
    v: string;
    builtAt: number;
    t: string[];
    /** [musicId, 曲名idx, 乐队名idx, 乐队id, [等级×4], [显示等级×4], 封面资产名idx, musicType, 标签[]] */
    songs: Array<[number, number, number, number, number[], number[], number, number, number[]]>;
    mcards: MemberCardTuple[];
    scards: SupportCardTuple[];
    /** [id, 名idx, bandId] */
    chars: Array<[number, number, number]>;
    /** [id, 名idx] */
    bands: Array<[number, number]>;
    /** exp → 等级 的累计阈值（导入时算等级用） */
    memberCardLevels: Record<string, number[]>;
    supportCardLevels: Record<string, number[]>;
    /** 角色等级：exp 阈值 + 每级加成（单位 10000） */
    charRank: { exp: number[]; bonus: number[] };
    /** 角色总等级加成 [[totalRank, bonus], …] */
    charTotalRank: Array<[number, number]>;
    /** [id, 名idx, 图片路径idx, 上限] */
    items: Array<[number, number, number, number]>;
    /** [id, 名idx, bandId] */
    bandItems: Array<[number, number, number]>;

    // ---- 组卡器：卡力 ----
    memberLevelRates: Record<string, RateTriple[]>;
    memberAwakeRates: Record<string, RateTriple[]>;
    memberRankRates: Record<string, RateTriple[]>;
    memberLevelCap: Record<string, number[]>;
    supportLevelRates: Record<string, RateTriple[]>;
    /** 留影卡突破：组 → [突破次数 0..4 的 [上限, 技能1, 技能2, 激奏1, 激奏2, 类型链接率]] */
    supportRank: Record<string, Array<[number, number, number, number, number, number]>>;
    /** bandItemId → [[等级, 效果值, …目标id], …] */
    bandItemEffects: Record<string, number[][]>;

    // ---- 全量模型（fmt 3）----
    /** skillTargetId → [bandId, characterId, cardType, tagId]（0 = 该选择器不生效） */
    skillTargets: Record<string, [number, number, number, number]>;
    /** [leaderSkillId, level, skillEffectType, effectValue, …目标id] */
    leaderSkillEffects: LeaderSkillEffectRow[];
    /** 成员卡觉醒组：组 → [觉醒次数 0..4 的 [队长技能等级, 音乐类型加成率, 音乐标签加成率]] */
    memberRankExtras: Record<string, Array<[number, number, number]>>;
    /** T.G.W CARD 加成 [[vipRank, 加成率], …] */
    tgwRates: Array<[number, number]>;
    /** 类型链接 / 类型加成 / 偏好曲的基础加成率 */
    rateBases: { typeBase: number; tagBase: number; linkBase: number };
    /**
     * live 技能的无条件得分比率：liveSkillID → [等级 1..maxLevel 的值, …]，单位 10000 = 100%。
     * 全量档的技能基准 = 成员卡 liveSkillID 对应数组、下标 = 该卡技能等级 - 1（方案1~4 用）。
     *
     * **v3 旧版 bundle 没有这个字段**（v3→v4 是尾部追加的可读兼容改动）——消费方按缺省处理：
     * liveSkillID 读到 0、liveSkillRatios 为空 ⇒ 技能基准回退统一 +60%（见 deckSkillBaseline）。
     */
    liveSkillRatios?: Record<string, number[]>;
    /** 活动加成条件行，见服务端的字段说明 */
    eventEffects: number[][];
}

/** 账号包里的原始 _player(紧凑键) */
export interface RawPlayer {
    name?: unknown;
    aid?: unknown;
    pkg?: unknown;
    m?: unknown;
    s?: unknown;
    c?: unknown;
    i?: unknown;
    b?: unknown;
    lr?: unknown;
    hr?: unknown;
    /** T.G.W CARD 等级；存档里通常没有，有几种历史写法 */
    _vipRank?: unknown;
    _vip_rank?: unknown;
    _tgwCardRank?: unknown;
    /** 没有 vip 字段时用它判断「有没有订阅」，好提示等级未知 */
    _monthlyPass?: unknown;
}

/** 一条歌曲成绩 */
export interface SongResult {
    musicId: number;
    highScore: number;
    /** 四难度, 顺序 EASY/NORMAL/HARD/EXPERT; [最高分, 通关状态原始值] */
    per: Array<[number, number]>;
}

export interface B25TopEntry {
    musicId: number;
    difficulty: number;
    /** 计入值: AP 记原等级, FC 记原等级 - 1 */
    counted: number;
    /** 谱面显示等级 */
    level: number;
    score: number;
    ap: boolean;
}

/** 换算完的结果 —— 这就是上传给服务端的形状 */
export interface AnalyzedAccount {
    player: {
        name: string;
        uid: string | null;
        /** 账号包来源渠道(master 的 pkg) */
        packageId: string;
        server: ServerKey;
        masterVersion: string;
        /** T.G.W CARD 等级（全量模型用）；存档里没有该字段时按 1 级（无加成） */
        tgwCardRank: number;
        /** 有付费会员记录但读不到等级 —— 界面上要提示「T.G.W 等级按 1 级处理」 */
        tgwUncertain: boolean;
    };
    cards: {
        members: Array<[number, number, number, number, number, number]>;
        supports: Array<[number, number, number]>;
        characters: Array<[number, number]>;
    };
    items: {
        items: Array<[number, number]>;
        bandItems: Array<[number, number]>;
    };
    songs: {
        results: Array<[number, number, Array<[number, number]>]>;
        b25: { top: Array<[number, number, number, number, number]>; totalRating: number };
    };
    /** 仅供界面展示, 不参与上传的统计 */
    summary: {
        members: number;
        supports: number;
        characters: number;
        items: number;
        songs: number;
        fc: number;
        ap: number;
        b25Count: number;
        b25RatingAvg: number | null;
        /** 主数据里查不到的成员卡 / 留影卡 id —— 通常是服务器选错了 */
        unknownMemberIds: number[];
        unknownSupportIds: number[];
    };
}

/** 账号包来源渠道 → 本站服务器。国际版两个渠道都归到 en。 */
export const PKG_TO_SERVER: Record<string, ServerKey> = {
    'com.bushiroad.sirius': 'jp',
    'com.bilibili.sirius.official': 'en',
    'com.bilibili.sirius': 'en',
};

export const PKG_LABELS: Record<string, string> = {
    'com.bushiroad.sirius': '日服',
    'com.bilibili.sirius.official': '国际版（官网）',
    'com.bilibili.sirius': '国际版（Google Play）',
};
