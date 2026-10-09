/**
 * ⚠ 移植自 web/client/src/accountPackage/optimize.ts（网页组卡器）—— **保持同逻辑**：
 * 两边任何一边改了算法，另一边要同步（bot 侧 scripts/verify-deck-port.ts 用同一份样例
 * 数据对照数值）。除 import 来源与下方补充的类型别名外，不要改动运算本体 ——
 * 尤其是 bp（×10000）与 f32(Math.fround) 的往返，那是照游戏客户端舍入逐步对齐的。
 */
import {
    ASSUMED_SKILL_MULTIPLIER,
    OVERHEAD_MS,
    RANK_LABELS,
    deckPower,
    eventBonus,
    expectedScore,
    memberPower,
    playsPerHour,
    scoreRank,
    supportRates,
    type ChartEfficiency,
    type DeckInput,
    type DeckPower,
    type DeckPrecision,
    type OwnedMember,
    type OwnedSupport,
} from './deck';
import type { GameAccountCardsData, GameAccountItemsData } from './types';
import type { MasterBundle } from './types';

/**
 * 组卡器的搜索。
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
/** 输出几套队伍 */
const EVENT_DECKS = 4;
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
    liveRewards: Array<{ scoreRank: number; points: number; items: Array<{ name: string; count: number }> }>;
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
    /** 普通模式：评级优先、同级时长最短优先；活动模式：点数/小时 */
    songs: SongGroup[];
    /** 活动模式：队伍 × 歌曲 的收益组合（同一队同一首歌的连续难度同样合并） */
    combos: Array<{ deck: DeckSuggestion; group: SongGroup }>;
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
    const { bundle, charts, event } = input;
    const mode: 'normal' | 'event' = event ? 'event' : 'normal';
    const precision: DeckPrecision = input.precision ?? 'precise';
    const notes: string[] = [];

    const members = input.cards.members.map(m => ({ cardId: m[0], level: m[1], training: m[2], awakening: m[3] }));
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
        '演出技能按游戏基础值 +100% 估算（与站内其它效率数据同一口径），未使用各卡的实际技能倍率；' +
            '队伍之间的比较是公平的，但绝对分数会与游戏有出入。'
    );

    // ---- 剪枝：按「单卡自身卡力 + 该卡自己能拿到的活动加成」排序 ----
    const memberValue = (m: OwnedMember): number => {
        const p = memberPower(bundle, m);
        const own = p ? p.total : 0;
        if (!event) return own;
        const b = eventBonus(bundle, event.eventId, [m], []);
        return own * (1 + b.total.eventPt / 10000 + b.total.parameter / 10000);
    };
    const supportValue = (s: OwnedSupport): number => {
        const rates = supportRates(bundle, s);
        const own = rates[0] + rates[1] + rates[2];
        if (!event) return own;
        const b = eventBonus(bundle, event.eventId, [], [s]);
        return own + b.total.eventPt + b.total.shopPt + b.total.parameter;
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
        let best: DeckSuggestion | null = null;

        for (const snapSet of supportCombos) {
            // 枚举时先不带歌曲 —— 全量模型里类型加成/偏好曲跟着歌走，
            // 这里要的是「与歌无关的基准综合力」，挑歌时再逐首加上去。
            const deckInput: DeckInput = {
                members: picked,
                supports: snapSet,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
            };
            let bonus: { eventPt: number; shopPt: number } | null = null;
            if (event) {
                const b = eventBonus(bundle, event.eventId, picked, snapSet);
                bonus = { eventPt: b.total.eventPt, shopPt: b.total.shopPt };
                deckInput.bonus = { perMember: b.perMember, perSupport: b.perSupport };
            }
            const power = deckPower(bundle, deckInput);
            const score = event ? power.total * (1 + (bonus?.eventPt ?? 0) / 10000) : power.total;
            if (!best || score > best.score) best = { members: picked, supports: snapSet, power, bonus, score };
        }
        if (best) decks.push(best);
    }

    decks.sort((a, b) => b.score - a.score);

    // 全量模型下队长技能只由**队长**那张卡决定，所以挑完队伍还要再选一次「谁是队长」。
    // 只在排名靠前的几套上试（每套 5 次），不给整个枚举过程乘以 5。
    if (precision === 'full') {
        // 复用枚举时那套「构造 DeckInput」的逻辑，免得活动参数加成被漏掉
        const evaluate = (members: OwnedMember[], supports2: OwnedSupport[]) => {
            const deckInput: DeckInput = {
                members,
                supports: supports2,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
            };
            if (event) {
                const b = eventBonus(bundle, event.eventId, members, supports2);
                deckInput.bonus = { perMember: b.perMember, perSupport: b.perSupport };
            }
            return deckPower(bundle, deckInput);
        };

        for (const deck of decks.slice(0, LEADER_TRIALS)) {
            let bestMembers = deck.members;
            let bestPower = deck.power;
            let bestScore = deck.score;
            // 依次把每张卡放到队首当队长，取综合力最高的那个排法
            for (const m of deck.members) {
                const ordered = [m, ...deck.members.filter(x => x !== m)];
                const power = evaluate(ordered, deck.supports);
                const score = event ? power.total * (1 + (deck.bonus?.eventPt ?? 0) / 10000) : power.total;
                if (score > bestScore) {
                    bestMembers = ordered;
                    bestPower = power;
                    bestScore = score;
                }
            }
            deck.members = bestMembers;
            deck.power = bestPower;
            deck.score = bestScore;
        }
        decks.sort((a, b) => b.score - a.score);
    }

    const topDecks = mode === 'event' ? decks.slice(0, EVENT_DECKS) : decks.slice(0, 1);

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
        ? pickSongs(topDecks[0], charts, mode, event, 10, precision === 'full' ? powerForSong : undefined)
        : [];

    // ---- 活动模式：队伍 × 歌曲 ----
    // 先按 (队伍, 歌) 逐个列出来排序，再把连续的同队同曲难度合起来 ——
    // 合并必须在排序之后做，否则「连续才合并」这条就无从判断。
    let combos: Array<{ deck: DeckSuggestion; group: SongGroup }> = [];
    if (mode === 'event') {
        const flat: Array<{ deck: DeckSuggestion; song: SongPick }> = [];
        for (const deck of topDecks) {
            for (const group of pickSongs(deck, charts, 'event', event, 25, precision === 'full' ? powerForSong : undefined)) {
                for (const song of group.picks) flat.push({ deck, song });
            }
        }
        flat.sort((a, b) => b.song.pointsPerHour - a.song.pointsPerHour);

        const merged: Array<{ deck: DeckSuggestion; group: SongGroup }> = [];
        for (const item of flat) {
            const last = merged[merged.length - 1];
            // 连续 = 同一个队伍 + 同一首歌
            if (last && last.deck === item.deck && last.group.musicId === item.song.musicId) {
                last.group.picks.push(item.song);
                continue;
            }
            merged.push({ deck: item.deck, group: { musicId: item.song.musicId, picks: [item.song], lead: item.song } });
        }
        for (const m of merged) sortPicksByDifficulty(m.group);
        combos = merged.slice(0, 10);
    }

    return { mode, decks: topDecks, songs, combos, notes };
}

/** 难度从高到低：EXPERT → HARD → NORMAL → EASY */
function sortPicksByDifficulty(group: SongGroup): void {
    group.picks.sort((a, b) => b.difficulty - a.difficulty);
}

// ---------------------------------------------------------------- 挑歌

function pickSongs(
    deck: DeckSuggestion,
    charts: ChartEfficiency[],
    mode: 'normal' | 'event',
    event: OptimizeEvent | undefined,
    limit: number,
    /** 全量模型下按歌算综合力；不给就用队伍的基准综合力 */
    powerForSong?: (deck: DeckSuggestion, chart: ChartEfficiency) => number
): SongGroup[] {
    const skills = Array.from({ length: DECK_SIZE }, () => ASSUMED_SKILL_MULTIPLIER);
    const picks: SongPick[] = [];

    for (const chart of charts) {
        const power = powerForSong ? powerForSong(deck, chart) : deck.power.total;
        const score = expectedScore(power, chart, skills);
        const rank = scoreRank(chart, score);
        // 连最低评级都够不着 → 这首对本队没有参考价值
        if (!rank) continue;

        const reward = event?.liveRewards.find(r => r.scoreRank === rank[0]);
        const perPlay = reward?.points ?? 0;
        const ph = playsPerHour(chart);
        const drops = (reward?.items ?? []).map(i => ({ name: i.name, perPlay: i.count }));

        picks.push({
            musicId: chart.musicId,
            difficulty: chart.difficulty,
            difficultyLabel: ['EASY', 'NORMAL', 'HARD', 'EXPERT'][chart.difficulty] ?? '?',
            displayLevel: chart.displayLevel,
            score,
            rankNumber: rank[0],
            rankLabel: RANK_LABELS[rank[0]] ?? '?',
            playMs: chart.bgmMs + OVERHEAD_MS,
            playsPerHour: ph,
            pointsPerPlay: perPlay,
            pointsPerHour: perPlay * ph,
            itemsPerHour: drops.reduce((s, d) => s + d.perPlay, 0) * ph,
            drops,
        });
    }

    if (mode === 'event') {
        picks.sort((a, b) => b.pointsPerHour - a.pointsPerHour);
    } else {
        // 普通模式按用户给的规则：**先看能打到什么评级（高的在前），同评级内时长越短越前**
        picks.sort((a, b) => b.rankNumber - a.rankNumber || a.playMs - b.playMs);
    }

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
