/**
 * ⚠ 移植自 web/client/src/accountPackage/optimize.ts（网页组卡器）—— **保持同逻辑**：
 * 两边任何一边改了算法，另一边要同步（bot 侧 scripts/verify-deck-port.ts 用同一份样例
 * 数据对照数值）。除 import 来源与下方补充的类型别名外，不要改动运算本体 ——
 * 尤其是 bp（×10000）与 f32(Math.fround) 的往返，那是照游戏客户端舍入逐步对齐的。
 *
 * 活动模式（自由live / 挑战live 的收益搜索）在 ./eventOptimize.ts —— 那份同样两边成对同步。
 */
import {
    OVERHEAD_MS,
    RANK_LABELS,
    baselineForScheme,
    deckPower,
    LIVE_DEGRADED_NOTE,
    deckSkillBaseline,
    expectedScoreBaseline,
    hasDuplicateCharacter,
    liveSkillsAvailable,
    memberPower,
    playsPerHour,
    scoreRank,
    skillBaselineNote,
    supportRates,
    type ChartEfficiency,
    type DeckPower,
    type DeckPrecision,
    type DeckScheme,
    type OwnedMember,
    type OwnedSupport,
    type SkillBaseline,
} from './deck';
export type { DeckScheme } from './deck';
import { optimizeEvent } from './eventOptimize';
import type { GameAccountCardsData, GameAccountItemsData } from './types';
import type { MasterBundle } from './types';

/**
 * 组卡器的搜索（**普通模式**：最高综合力 + 效率曲）。
 *
 * 活动模式（自由live / 挑战live 的收益最大化）在 `./eventOptimize`，本文件只负责分发过去。
 *
 * ⚠️ **这是启发式的，不保证全局最优。** 参考站用 CP-SAT 求解器（跑在 Pyodide 里）求精确最优；
 * 这里靠「按单卡价值剪枝 + 在小候选池上穷举」，原因是组合数太吓人：
 * 卡库 500 张时 C(500,5) ≈ 2.6e11，浏览器里根本跑不完。剪枝到 18 张后 C(18,5) = 8568，
 * 再乘上若干组留影卡，几万次评估，一两秒内能出结果。
 *
 * 界面上必须如实写「启发式推荐」，不能写成「最优解」。
 */

const DECK_SIZE = 5;
/** 成员候选池大小：C(18,5) = 8568 */
const MEMBER_POOL = 18;
/** 留影候选池大小 */
const SUPPORT_POOL = 12;
/** 预选出的留影组合数（对每个成员组合都试这几组） */
const SUPPORT_COMBOS = 8;
/** 全量模型下，对排名前几套队伍再试一遍「谁是队长」（每套 5 次评估） */
const LEADER_TRIALS = 8;

export interface DeckSuggestion {
    members: OwnedMember[];
    supports: OwnedSupport[];
    power: DeckPower;
    /** 活动点数/交换所点数加成，单位 10000 = 100% */
    bonus: { eventPt: number; shopPt: number } | null;
    /** 排序用的目标值（普通 = 综合力；活动 = 综合力 ×(1+点数加成)） */
    score: number;
}

export interface SongPick {
    musicId: number;
    difficulty: number;
    difficultyLabel: string;
    displayLevel: number;
    score: number;
    rankNumber: number;
    rankLabel: string;
    /** 每局耗时（含固定结算开销） */
    playMs: number;
    playsPerHour: number;
    pointsPerPlay: number;
    pointsPerHour: number;
    itemsPerHour: number;
    drops: Array<{ name: string; perPlay: number }>;
}

export interface OptimizeEvent {
    eventId: number;
    /** 自由live 的演出报酬表（各评级 → 点数 + 道具） */
    liveRewards: Array<{ scoreRank: number; points: number; items: Array<{ name: string; count: number }> }>;
    /** 挑战live 的演出报酬表（MasterChallengeLiveEvent*）；缺省 = 不出挑战榜 */
    challengeRewards?: Array<{ scoreRank: number; points: number; items: Array<{ name: string; count: number }> }>;
    /** 活动加成涉及的乐队（自由live「活动加成乐队」那组榜用它筛曲）；缺省 = 不出该组 */
    bonusBandIds?: number[];
    /** 活动挑战曲池（MasterChallengeMusic）；缺省 = 不出挑战榜 */
    challengeMusicIds?: number[];
}

/** 收益表的指标：最高点数 / 最高道具量 / 两者相加最大 */
export type EventMetric = 'pt' | 'items' | 'sum';
/** 一组榜的范围：自由live 全曲池 / 自由live 活动加成乐队 / 挑战live 活动挑战曲 */
export type EventBoardScope = 'free-all' | 'free-band' | 'challenge';

/** 一条推荐：一首歌（取它的一个难度）+ **这套推荐自己的编队** */
export interface EventPick {
    deck: DeckSuggestion;
    musicId: number;
    difficulty: number;
    difficultyLabel: string;
    /** 同一首歌里同样能拿到该评级的其它难度（合并展示用，从难到易，含自己） */
    difficultyVariants: number[];
    /** 拿到该评级**最少**需要多少综合力（同评级各难度取最小） */
    requiredPower: number;
    /** 曲子本身的时长（不含结算开销），出图展示用 */
    musicMs: number;
    displayLevel: number;
    rankNumber: number;
    rankLabel: string;
    /** 该编队在这首歌上的期望得分 */
    score: number;
    /** 该编队在这首歌上的综合力（全量档是逐歌算的） */
    power: number;
    playMs: number;
    playsPerHour: number;
    /** 该评级的原始点数/道具（未乘加成） */
    pointsPerPlay: number;
    itemsPerPlay: number;
    /** 实际收益：已乘 (1+活动点加成) / (1+交换所加成) */
    pointsPerHour: number;
    itemsPerHour: number;
    /** pt/ptMax + 道具/道具Max（ptMax/itemsMax 看所在榜） */
    sumScore: number;
    drops: Array<{ name: string; perPlay: number }>;
}

export interface EventTable {
    metric: EventMetric;
    rows: EventPick[];
}

/** 一组榜：一个范围 × 三张表（点数 / 道具 / 相加）＋ 该范围的归一化基准 */
export interface EventBoard {
    scope: EventBoardScope;
    title: string;
    /** 相加分的两个基准（该范围内所有 (编队,歌曲) 对的最大值）；跨组不可比 */
    ptMax: number;
    itemsMax: number;
    tables: EventTable[];
}

export interface OptimizeInput {
    bundle: MasterBundle;
    cards: GameAccountCardsData;
    items: GameAccountItemsData;
    charts: ChartEfficiency[];
    /** 传了就是活动模式 */
    event?: OptimizeEvent;
    /** 精度档位：precise（默认）= 卡力+角色等级+留影+道具；full = 再加队长技能/类型链接/类型加成/偏好曲/T.G.W */
    precision?: DeckPrecision;
    /** T.G.W CARD 等级（导入记录里带的），全量模型才用 */
    tgwCardRank?: number;
    /**
     * 搜索方案（**按精准度编号：0 最准**）：
     * 0 全曲+实际基准 / 1 均值基准取序（卡库练度识别）/ 2 曲长前 50+两档加成队 /
     * 3 基准取序（可自定义，bot 固定用）/ 4 队伍反采（先编队伍反推歌曲）。
     * 缺省 3（= bot 的口径，各槽默认 +60%；网页 UI 的默认方案是 1，由界面显式传入）。
     */
    scheme?: DeckScheme;
    /**
     * **方案3 专用**：五槽技能基准手填值（% 数组，60 = +60%；与参考站「五项手填值」同款口径）。
     * 缺省 [60,60,60,60,60]。其余方案忽略它（按各卡 live 技能/50%）。
     */
    skillBaselinePercent?: number[];
}

/**
 * 一首歌（可能含多个难度）的推荐项。
 *
 * 同一首歌的四个难度在排序里常常是挨着的（同曲同评级同时长、BGM 时长也一样），
 * 每行都重复一遍曲名没有信息量，所以**排序连续的同曲项合并成一条**，
 * 难度并排展示、按 EXPERT → HARD → NORMAL → EASY 排。
 * 注意只在**连续**时合并：中间插进了别的歌就还是分开列，免得把名次顺序讲乱。
 */
export interface SongGroup {
    musicId: number;
    /** 组内各难度，已按 EXPERT → HARD → NORMAL → EASY 排好 */
    picks: SongPick[];
    /** 排序上最优的那条（也就是这个组为什么排在这），列表主行用它 */
    lead: SongPick;
}

export interface OptimizeResult {
    mode: 'normal' | 'event';
    decks: DeckSuggestion[];
    /** 普通模式：评级优先、同级时长最短优先（活动模式一律为空，改看 boards） */
    songs: SongGroup[];
    /** 普通模式恒为空；活动模式也恒为空（旧的「队伍×歌曲」列表已被 boards 取代） */
    combos: Array<{ deck: DeckSuggestion; group: SongGroup }>;
    /**
     * 仅活动模式：分范围的多表收益（自由live 全曲池 / 自由live 活动乐队 / 挑战live）。
     * **普通模式不设这个键**，好让普通模式的输出与旧版逐字节一致。
     */
    boards?: EventBoard[];
    /** 该说的话（启发式说明、技能估算说明、数据不足等）如实带到界面上 */
    notes: string[];
}

// ---------------------------------------------------------------- 组合枚举

function* combinationIndices(n: number, k: number): Generator<number[]> {
    if (k > n) return;
    const idx = Array.from({ length: k }, (_, i) => i);
    for (;;) {
        yield idx.slice();
        let i = k - 1;
        while (i >= 0 && idx[i] === n - k + i) i--;
        if (i < 0) return;
        idx[i]++;
        for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
}

// ---------------------------------------------------------------- 主流程

export function optimize(input: OptimizeInput): OptimizeResult {
    // 活动模式走专门的收益搜索（自由live / 挑战live 两套口径，见 eventOptimize.ts）
    if (input.event) return optimizeEvent(input, input.event);

    const { bundle, charts } = input;
    const mode = 'normal' as const;
    const precision: DeckPrecision = input.precision ?? 'precise';
    const scheme: DeckScheme = input.scheme ?? 3;
    const baseline = baselineForScheme(scheme, precision, input.skillBaselinePercent);
    const notes: string[] = [];

    const members = input.cards.members.map(m => ({ cardId: m[0], level: m[1], training: m[2], awakening: m[3], liveSkillLevel: m[4] }));
    const supports = input.cards.supports.map(s => ({ cardId: s[0], level: s[1], limitBreak: s[2] }));
    const characterRanks = new Map(input.cards.characters.map(c => [c[0], c[1]]));
    const bandItemLevels = new Map(input.items.bandItems.map(b => [b[0], b[1]]));

    if (members.length < DECK_SIZE) {
        return { mode, decks: [], songs: [], combos: [], notes: ['成员卡不足 5 张，组不了队。'] };
    }

    notes.push(
        '这是**启发式推荐**：先从卡库里按单卡价值筛出候选，再在小候选池上穷举组合，不保证是全局最优解。'
    );
    notes.push(
        skillBaselineNote(scheme, precision, input.skillBaselinePercent) + '队伍之间的比较是公平的，但绝对分数会与游戏有出入。'
    );
    if (baseline === 'live' && !liveSkillsAvailable(bundle)) notes.push(LIVE_DEGRADED_NOTE);

    // ---- 剪枝：普通模式没有活动加成，单卡价值就是它自己的卡力 / 支援率 ----
    const memberValue = (m: OwnedMember): number => memberPower(bundle, m)?.total ?? 0;
    const supportValue = (s: OwnedSupport): number => {
        const rates = supportRates(bundle, s);
        return rates[0] + rates[1] + rates[2];
    };

    const rankedMembers = [...members].sort((a, b) => memberValue(b) - memberValue(a));
    const memberPool = rankedMembers.slice(0, MEMBER_POOL);
    if (members.length > MEMBER_POOL) {
        notes.push(`成员卡共 ${members.length} 张，按单卡价值筛出前 ${MEMBER_POOL} 张参与组合枚举。`);
    }

    // ---- 留影候选组合：也先按单卡价值剪枝，再取前若干组 ----
    let supportCombos: OwnedSupport[][];
    if (supports.length >= DECK_SIZE) {
        const rankedSupports = [...supports].sort((a, b) => supportValue(b) - supportValue(a));
        const supportPool = rankedSupports.slice(0, SUPPORT_POOL);
        supportCombos = [];
        for (const combo of combinationIndices(supportPool.length, DECK_SIZE)) {
            supportCombos.push(combo.map(i => supportPool[i]));
            if (supportCombos.length >= SUPPORT_COMBOS) break;
        }
        if (supports.length > SUPPORT_POOL) {
            notes.push(`留影卡共 ${supports.length} 张，筛出前 ${SUPPORT_POOL} 张、取其中前 ${supportCombos.length} 组参与比较。`);
        }
        // 再补一组「支援率最高」的：上面的排序混了活动加成，纯卡力最优的那组可能被挤掉
        const byRate = [...supports].sort(
            (a, b) => supportRates(bundle, b).reduce((x, y) => x + y, 0) - supportRates(bundle, a).reduce((x, y) => x + y, 0)
        );
        const pureTop = byRate.slice(0, DECK_SIZE);
        if (pureTop.length === DECK_SIZE) supportCombos.push(pureTop);
    } else {
        notes.push('留影卡不足 5 张，留影卡的支援率按 0 计。');
        supportCombos = [[]];
    }

    // ---- 枚举 ----
    const decks: DeckSuggestion[] = [];
    for (const combo of combinationIndices(memberPool.length, DECK_SIZE)) {
        const picked = combo.map(i => memberPool[i]);
        // 同一角色只能上一张角色卡（参考站组卡器的 legality）
        if (hasDuplicateCharacter(bundle, picked)) continue;
        let best: DeckSuggestion | null = null;

        for (const snapSet of supportCombos) {
            // 枚举时先不带歌曲 —— 全量模型里类型加成/偏好曲跟着歌走，
            // 这里要的是「与歌无关的基准综合力」，挑歌时再逐首加上去。
            const power = deckPower(bundle, {
                members: picked,
                supports: snapSet,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
            });
            if (!best || power.total > best.score) {
                best = { members: picked, supports: snapSet, power, bonus: null, score: power.total };
            }
        }
        if (best) decks.push(best);
    }

    decks.sort((a, b) => b.score - a.score);

    // 全量模型下队长技能只由**队长**那张卡决定，所以挑完队伍还要再选一次「谁是队长」。
    // 只在排名靠前的几套上试（每套 5 次），不给整个枚举过程乘以 5。
    if (precision === 'full') {
        const evaluate = (members: OwnedMember[], supports2: OwnedSupport[]) =>
            deckPower(bundle, {
                members,
                supports: supports2,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
            });

        for (const deck of decks.slice(0, LEADER_TRIALS)) {
            let bestMembers = deck.members;
            let bestPower = deck.power;
            let bestScore = deck.score;
            // 依次把每张卡放到队首当队长，取综合力最高的那个排法
            for (const m of deck.members) {
                const ordered = [m, ...deck.members.filter(x => x !== m)];
                const power = evaluate(ordered, deck.supports);
                if (power.total > bestScore) {
                    bestMembers = ordered;
                    bestPower = power;
                    bestScore = power.total;
                }
            }
            deck.members = bestMembers;
            deck.power = bestPower;
            deck.score = bestScore;
        }
        decks.sort((a, b) => b.score - a.score);
    }

    const topDecks = decks.slice(0, 1);

    // ---- 挑歌用的「按歌算综合力」 ----
    // 全量模型下同一套队伍打不同的歌综合力不同（类型加成 / 偏好曲），所以这里逐首重算；
    // precise 档与歌无关，直接返回基准值，一次表都不用再查。
    const songMeta = new Map(
        bundle.songs.map(s => [s[0], { musicType: s[7] ?? 0, tags: (s[8] ?? []) as number[] }])
    );
    const powerForSong = (deck: DeckSuggestion, chart: ChartEfficiency): number => {
        if (precision !== 'full') return deck.power.total;
        const meta = songMeta.get(chart.musicId);
        if (!meta) return deck.power.total;
        return deckPower(bundle, {
            members: deck.members,
            supports: deck.supports,
            characterRanks,
            bandItemLevels,
            precision,
            tgwCardRank: input.tgwCardRank,
            song: { musicType: meta.musicType, bestMusicTagIDs: meta.tags },
        }).total;
    };

    // ---- 歌曲 ----
    const songs = topDecks[0]
        ? pickSongs(
              topDecks[0],
              charts,
              deckSkillBaseline(bundle, topDecks[0].members, baseline),
              mode,
              10,
              precision === 'full' ? powerForSong : undefined
          )
        : [];

    return { mode, decks: topDecks, songs, combos: [], notes };
}

/** 难度从高到低：EXPERT → HARD → NORMAL → EASY */
function sortPicksByDifficulty(group: SongGroup): void {
    group.picks.sort((a, b) => b.difficulty - a.difficulty);
}

// ---------------------------------------------------------------- 挑歌

function pickSongs(
    deck: DeckSuggestion,
    charts: ChartEfficiency[],
    /** 该队的技能基准（逐槽倍率；方案0 = 统一 60%、方案1~3 = 各卡 live 技能/50%） */
    skills: number[],
    mode: 'normal',
    limit: number,
    /** 全量模型下按歌算综合力；不给就用队伍的基准综合力 */
    powerForSong?: (deck: DeckSuggestion, chart: ChartEfficiency) => number
): SongGroup[] {
    const picks: SongPick[] = [];

    for (const chart of charts) {
        const power = powerForSong ? powerForSong(deck, chart) : deck.power.total;
        const score = expectedScoreBaseline(power, chart, skills);
        const rank = scoreRank(chart, score);
        // 连最低评级都够不着 → 这首对本队没有参考价值
        if (!rank) continue;

        picks.push({
            musicId: chart.musicId,
            difficulty: chart.difficulty,
            difficultyLabel: ['EASY', 'NORMAL', 'HARD', 'EXPERT'][chart.difficulty] ?? '?',
            displayLevel: chart.displayLevel,
            score,
            rankNumber: rank[0],
            rankLabel: RANK_LABELS[rank[0]] ?? '?',
            playMs: chart.bgmMs + OVERHEAD_MS,
            playsPerHour: playsPerHour(chart),
            // 收益字段只有活动模式才填（活动模式走 eventOptimize.ts 的 boards），这里留零
            pointsPerPlay: 0,
            pointsPerHour: 0,
            itemsPerHour: 0,
            drops: [],
        });
    }

    // 普通模式按用户给的规则：**先看能打到什么评级（高的在前），同评级内时长越短越前**
    picks.sort((a, b) => b.rankNumber - a.rankNumber || a.playMs - b.playMs);

    // 把**排序上连续**的同曲难度合成一条。只在连续时合并：
    // 中间插进了别的歌就分开列，否则会把名次顺序讲乱（第 3 名和第 7 名不能并成一项）。
    const groups: SongGroup[] = [];
    for (const pick of picks) {
        const last = groups[groups.length - 1];
        if (last && last.musicId === pick.musicId) {
            last.picks.push(pick);
            continue;
        }
        groups.push({ musicId: pick.musicId, picks: [pick], lead: pick });
    }
    for (const g of groups) sortPicksByDifficulty(g);

    // 限的是**首数**（合并后的一条算一首），正好对上「推荐 10 首」
    return groups.slice(0, limit);
}
