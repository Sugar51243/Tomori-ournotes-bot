/**
 * ⚠ 移植自 web/client/src/accountPackage/eventOptimize.ts（网页组卡器）—— **保持同逻辑**：
 * 两边任何一边改了算法，另一边要同步（bot 侧 scripts/verify-deck-port.ts 用同一份样例数据对照）。
 *
 * 活动模式的收益搜索（自由live / 挑战live 两套口径）。
 *
 * 口径：
 * - 收益 = 该评级报酬 ×(1 + 加成) × 局/时。pt 吃 eventPt 加成、道具吃 shopPt 加成；
 *   **同评级下加成高者胜**，不同评级×加成直接比乘积，不按综合力排序。
 * - 自由live：parameter（综合力/属性）加成**不参与**综合力；有 pt 与道具加成。
 *   曲池 = 混池（按「乐团 × 属性」分组、每组效率前 5 首的并集）；两组榜：全池 5 首 + 活动加成乐队 1 首。
 * - 挑战live：parameter 参与综合力；报酬表用挑战演出报酬；曲池 = 活动挑战曲（不掺混池）。
 * - 相加表 = pt/ptMax + 道具/道具Max（各 scope 内各自归一化，跨表不可比）。
 *
 * 搜索三步（「奖励模型」思路）：
 *   ① 枚举卡库的编队（沿用网页同规模的剪枝 + 穷举），每套算基准综合力与加成；
 *   ② 按 (综合力, pt加成, 道具加成) 三维 Pareto 剔除被支配的编队 —— 收益对这三个轴都单调，
 *      被支配的队在任何歌上都不可能赢，所以这一步是**精确**剪枝；
 *   ③ 只对留下的编队 × 候选歌曲，用预计算的「评级门槛阶梯」二分出能拿的最高评级与报酬。
 *
 * 评级档位：每首歌只算「卡库天花板」往下 RANK_BAND 档（默认两档）——低一档的队凭更高加成
 * 可能反超，所以两档**混在同一个候选集**里按乘积统一排序，绝不按评级分档单算。
 */

import {
    OVERHEAD_MS,
    RANK_LABELS,
    LIVE_DEGRADED_NOTE,
    SKILL_BASELINE_FLAT,
    baselineForScheme,
    deckPower,
    deckSkillBaseline,
    eventBonus,
    hasDuplicateCharacter,
    liveSkillBaseline,
    liveSkillsAvailable,
    memberPower,
    playsPerHour,
    skillBaselineNote,
    skillMean,
    supportRates,
} from './deck';
import type { ChartEfficiency, DeckPrecision, DeckScheme, OwnedMember, OwnedSupport, SkillBaseline } from './deck';
import type { MasterBundle } from './types';
import type {
    DeckSuggestion,
    EventBoard,
    EventBoardScope,
    EventMetric,
    EventPick,
    EventTable,
    OptimizeEvent,
    OptimizeInput,
    OptimizeResult,
} from './optimize';

const DECK_SIZE = 5;
/** 成员候选池（C(18,5)=8568，与网页同规模） */
const MEMBER_POOL = 18;
/** 纯综合力保底进池的张数：保证天花板不被价值剪枝压低 */
const MEMBER_POWER_GUARD = 5;
/** 留影候选池 */
const SUPPORT_POOL = 12;
/** 对每个成员组合试几组留影 */
const SUPPORT_COMBOS = 8;
/** 评级天花板往下再保留几档（用户口径：最高的两档混在一起算） */
const RANK_BAND = 2;
/** 每个 (乐团 × 属性) 组取效率前几首进混池 */
const SONG_PER_GROUP = 5;
/** 每首歌的 Pareto 集合上限（正常数据到不了，防病态数据撑爆） */
const PARETO_CAP = 32;
/** Pareto 之外额外兜底保留的编队数（全量档逐歌综合力会变，给精修留余地） */
const EXTRA_POWER_TOPS = 200;
const EXTRA_BONUS_TOPS = 100;
/** 挑战候选集：先按「自由综合力 ×(1+参数加成)」粗筛，再算含加成的真实综合力 */
const CHALLENGE_SEED_TOPS = 1200;
/** 全量档逐歌精修：每首歌最多重算多少套编队（取该歌候选 + 基准综合力前几） */
const REFINE_DECKS = 60;
/** 全量档逐歌精修：每张表取前几名进精修集合（只取最终那一行的话，第 2 名精修后反超就没机会算准） */
const REFINE_TOPS = 16;
/** 全池榜出几首 */
const FREE_ALL_TOP = 5;

const DIFFICULTY_LABELS = ['EASY', 'NORMAL', 'HARD', 'EXPERT'];

/** 报酬表里的一行（按评级索引；itemsSum 是道具合计，排序与归一化都用它） */
interface Reward {
    points: number;
    items: Array<{ name: string; count: number }>;
    itemsSum: number;
}

/** 一套枚举出来的编队（只存判定要用的数，DeckPower 明细到出榜时再补算） */
interface DeckRow {
    members: OwnedMember[];
    supports: OwnedSupport[];
    /** 自由live 基准综合力（不含 parameter 加成） */
    powerFree: number;
    /** 挑战live 基准综合力（含 parameter 加成）；没算的为 null */
    powerChallenge: number | null;
    eventPt: number;
    shopPt: number;
    /** 参数加成合计（粗筛挑战候选用） */
    paramRate: number;
    /** 技能基准均值（评分模型用；方案0 = 统一常数，方案1~3 = 逐卡 live 技能） */
    skillMean: number;
}

/** 阶梯表的一级：某难度下拿到某评级的门槛分（绝对分数）与展示字段 */
interface LadderLevel {
    threshold: number;
    rankNumber: number;
    difficulty: number;
    displayLevel: number;
    playMs: number;
    playsPerHour: number;
    /** 曲子本身的时长（不含结算开销），出图展示用 */
    musicMs: number;
}

/** 一首候选歌的阶梯（levels 按门槛升序） */
interface SongLadder {
    musicId: number;
    bandId: number;
    musicType: number;
    bestMusicTagIDs: number[];
    /** 效率（分/综合力/分钟，取最好难度；按**排名基准**算）—— 混池按它分组取前几 */
    efficiency: number;
    /** 各难度的谱面系数：rate(skills) = base + 技能均值 × sumW */
    charts: Array<{ difficulty: number; base: number; sumW: number; slots: number }>;
    levels: LadderLevel[];
}

/** 某技能基准均值下这首歌每难度的分/综合力（charts 下标 = difficulty） */
function ladderRates(ladder: SongLadder, meanSkill: number): number[] {
    return ladder.charts.map(c => c.base + meanSkill * c.sumW);
}

/** 某编队在这首歌上各难度的最高评级（difficulty → rankNumber；没到 D 的不进表） */
function ladderRanks(ladder: SongLadder, power: number, rates: number[]): Map<number, number> {
    const best = new Map<number, number>();
    for (const level of ladder.levels) {
        const rate = rates[level.difficulty] ?? 0;
        if (rate > 0 && power * rate >= level.threshold) {
            const cur = best.get(level.difficulty) ?? 0;
            if (level.rankNumber > cur) best.set(level.difficulty, level.rankNumber);
        }
    }
    return best;
}

/** 扫描出来的一个候选点（同一编队、同一首歌、某一档评级） */
interface PickDraft {
    deck: DeckRow;
    musicId: number;
    difficulty: number;
    displayLevel: number;
    playMs: number;
    playsPerHour: number;
    rankNumber: number;
    /** 该编队在这首歌上的综合力（全量档是逐歌精修后的值） */
    power: number;
    /** 该谱面的 分/综合力（出榜时算期望得分用） */
    rate: number;
    /** 同一首歌里，这套编队同样能拿到该评级的其它难度（合并展示用，从难到易） */
    difficultyVariants: number[];
    /** 拿到该评级**最少**需要多少综合力（同评级里各难度取最小 —— 也就是「门槛」） */
    requiredPower: number;
    /** 曲子本身的时长（不含结算开销） */
    musicMs: number;
    pointsPerPlay: number;
    itemsPerPlay: number;
    pointsPerHour: number;
    itemsPerHour: number;
    drops: Array<{ name: string; count: number }>;
}

/** 榜单草稿：deck 还是 DeckRow，物化时才换成带明细的 DeckSuggestion */
interface BoardDraft {
    scope: EventBoardScope;
    title: string;
    ptMax: number;
    itemsMax: number;
    tables: Array<{ metric: EventMetric; picks: Array<{ musicId: number; draft: PickDraft }> }>;
}

// ---------------------------------------------------------------- 小工具

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

/**
 * 往 Pareto 集合里放一个点：两个收益轴都被支配就不进；进的话顺手删掉被它支配的。
 *
 * 收益**完全并列**时（同一评级、同一加成、同一局时 —— 多个难度都够得到这一档）按难度再比一手：
 * 让更难的那档留下展示（出图那行显示 EX 26.3 而不是 EASY 6）。注意 EASY 评级的「所需综合力」
 * 反而可能更高（它的分数系数低），只按门槛先来后到会把 EASY 顶上来。
 */
function paretoInsert(list: PickDraft[], p: PickDraft): void {
    const dominates = (a: PickDraft, b: PickDraft): boolean =>
        a.pointsPerHour >= b.pointsPerHour &&
        a.itemsPerHour >= b.itemsPerHour &&
        (a.pointsPerHour > b.pointsPerHour || a.itemsPerHour > b.itemsPerHour || a.difficulty >= b.difficulty);
    for (const q of list) {
        if (dominates(q, p)) return;
    }
    for (let i = list.length - 1; i >= 0; i--) {
        if (dominates(p, list[i])) list.splice(i, 1);
    }
    if (list.length < PARETO_CAP) list.push(p);
}

function fmt(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

function deckKey(row: DeckRow): string {
    return `${row.members.map(m => m.cardId).join('-')}/${row.supports.map(s => s.cardId).join('-')}`;
}

/** 报酬表 → 按评级索引；itemsSum = 该评级道具合计 */
function toRewardMap(rows: Array<{ scoreRank: number; points: number; items: Array<{ name: string; count: number }> }>): Map<number, Reward> {
    const map = new Map<number, Reward>();
    for (const row of rows) {
        const items = row.items.map(i => ({ name: i.name, count: i.count }));
        map.set(row.scoreRank, { points: row.points, items, itemsSum: items.reduce((s, i) => s + i.count, 0) });
    }
    return map;
}

// ---------------------------------------------------------------- 谱面阶梯与候选歌曲

/**
 * 把谱面折成「每首歌一张阶梯」：每档评级一行，只记**门槛分**与谱面系数 ——
 * 「最低综合力」不再预先烘焙（技能基准逐队不同），由扫描时按各队自己的基准现算：
 *   rate = base + 技能均值 × ΣW，minPower = ceil(threshold / rate)。
 *
 * `referenceMean` 是「排名基准」的技能均值（方案0 = 0.6，方案1 = 权力加权中位数），
 * 只用于 efficiency（混池分组取前几）；评级判定一律走各队实际基准。
 */
function buildLadder(bundle: MasterBundle, charts: ChartEfficiency[], referenceMean: number): SongLadder[] {
    const songMeta = new Map(
        bundle.songs.map(s => [s[0], { bandId: s[3] ?? 0, musicType: s[7] ?? 0, tags: (s[8] ?? []) as number[] }])
    );
    const bySong = new Map<number, ChartEfficiency[]>();
    for (const chart of charts) {
        const list = bySong.get(chart.musicId);
        if (list) list.push(chart);
        else bySong.set(chart.musicId, [chart]);
    }

    const ladders: SongLadder[] = [];
    for (const [musicId, list] of bySong) {
        const meta = songMeta.get(musicId) ?? { bandId: 0, musicType: 0, tags: [] };
        const levels: LadderLevel[] = [];
        const chartsOf: SongLadder['charts'] = [];
        let efficiency = 0;
        for (const chart of list) {
            const slots = chart.weightsFree.length;
            const sumW = chart.weightsFree.reduce((a, b) => a + b, 0);
            chartsOf.push({ difficulty: chart.difficulty, base: chart.baseFree, sumW, slots });
            const rate = chart.baseFree + referenceMean * sumW;
            if (!(rate > 0)) continue;
            const minutes = (chart.bgmMs + OVERHEAD_MS) / 60000;
            if (minutes > 0) efficiency = Math.max(efficiency, rate / minutes);
            for (const [rankNumber, threshold] of chart.ranks) {
                if (!(threshold > 0)) continue;
                levels.push({
                    threshold,
                    rankNumber,
                    difficulty: chart.difficulty,
                    displayLevel: chart.displayLevel,
                    playMs: chart.bgmMs + OVERHEAD_MS,
                    playsPerHour: playsPerHour(chart),
                    musicMs: chart.bgmMs,
                });
            }
        }
        if (!levels.length) continue;
        // 评级升序；同评级更高难度排后面（并列取更高难度时先见到更难的那档）
        levels.sort((a, b) => a.rankNumber - b.rankNumber || b.difficulty - a.difficulty);
        ladders.push({ musicId, bandId: meta.bandId, musicType: meta.musicType, bestMusicTagIDs: meta.tags, efficiency, charts: chartsOf, levels });
    }
    return ladders;
}

/**
 * 混池：按 (乐团 × 属性) 分组，每组按效率取前 SONG_PER_GROUP 首。
 * 榜单最多只要 5 首，没必要把全曲库都算一遍。
 */
function pickSongPool(ladders: SongLadder[]): number[] {
    const groups = new Map<string, SongLadder[]>();
    for (const ladder of ladders) {
        const key = `${ladder.bandId}|${ladder.musicType}`;
        const list = groups.get(key);
        if (list) list.push(ladder);
        else groups.set(key, [ladder]);
    }
    const pool = new Set<number>();
    for (const list of groups.values()) {
        list.sort((a, b) => b.efficiency - a.efficiency || a.musicId - b.musicId);
        for (const ladder of list.slice(0, SONG_PER_GROUP)) pool.add(ladder.musicId);
    }
    return [...pool];
}

// ---------------------------------------------------------------- 候选编队

/** 成员池：纯综合力前几名保底 + 其余按单卡价值补满（剔除低价值无加成卡，但不压低天花板） */
function buildMemberPool(bundle: MasterBundle, members: OwnedMember[], value: (m: OwnedMember) => number): OwnedMember[] {
    const byPower = [...members].sort((a, b) => (memberPower(bundle, b)?.total ?? 0) - (memberPower(bundle, a)?.total ?? 0));
    const byValue = [...members].sort((a, b) => value(b) - value(a));
    const pool: OwnedMember[] = [];
    const push = (m: OwnedMember): void => {
        if (pool.length < MEMBER_POOL && !pool.includes(m)) pool.push(m);
    };
    for (const m of byPower.slice(0, MEMBER_POWER_GUARD)) push(m);
    for (const m of byValue) push(m);
    return pool;
}

/** 留影候选组合：先按单卡价值取前若干张，再取其中的前几组；另补一组「纯支援率最高」的 */
function buildSupportCombos(bundle: MasterBundle, supports: OwnedSupport[], value: (s: OwnedSupport) => number): OwnedSupport[][] {
    if (supports.length < DECK_SIZE) return [[]];
    const ranked = [...supports].sort((a, b) => value(b) - value(a)).slice(0, SUPPORT_POOL);
    const combos: OwnedSupport[][] = [];
    for (const combo of combinationIndices(ranked.length, DECK_SIZE)) {
        combos.push(combo.map(i => ranked[i]));
        if (combos.length >= SUPPORT_COMBOS) break;
    }
    // 上面的排序混了活动加成，纯支援率最优的那组可能被挤掉，补一组
    const byRate = [...supports].sort(
        (a, b) => supportRates(bundle, b).reduce((x, y) => x + y, 0) - supportRates(bundle, a).reduce((x, y) => x + y, 0)
    );
    combos.push(byRate.slice(0, DECK_SIZE));
    return combos;
}

/**
 * 技能基准的「权力加权中位数」（方案1 的排名基准）：按卡力权重累计到一半处那档。
 * 结果天然偏向高综合力的卡（低力卡拉不动累计权重），与搜索的偏好一致。
 */
function weightedMedianBaseline(bundle: MasterBundle, memberPool: OwnedMember[]): number {
    const items = memberPool
        .map(m => ({ w: memberPower(bundle, m)?.total ?? 0, v: liveSkillBaseline(bundle, m) }))
        .filter(x => x.w > 0)
        .sort((a, b) => a.v - b.v || a.w - b.w);
    if (!items.length) return SKILL_BASELINE_FLAT;
    const total = items.reduce((sum, x) => sum + x.w, 0);
    let acc = 0;
    for (const item of items) {
        acc += item.w;
        if (acc >= total / 2) return item.v;
    }
    return items[items.length - 1].v;
}

/**
 * ① 枚举：每套编队的「基准综合力 + 加成」。
 *
 * 自由live 的基准综合力**不传 bonus**（parameter 不加进综合力）；挑战那份到需要时再算。
 * 队长试位（`full` 档下队长技能跟着队首那张卡走，卡序又决定「成员 i ↔ 留影 i」的配对）
 * 不在这里做 —— 7 万多套每套试 5 次太贵，挪到候选集上（见 `refineLeader`）。
 */
function enumerateDecks(
    bundle: MasterBundle,
    eventId: number,
    input: OptimizeInput,
    memberPool: OwnedMember[],
    supportCombos: OwnedSupport[][],
    characterRanks: Map<number, number>,
    bandItemLevels: Map<number, number>,
    precision: DeckPrecision,
    baseline: SkillBaseline
): DeckRow[] {
    const rows: DeckRow[] = [];
    for (const combo of combinationIndices(memberPool.length, DECK_SIZE)) {
        const picked = combo.map(i => memberPool[i]);
        // 同一角色只能上一张角色卡（参考站组卡器的 legality "duplicate-character"）
        if (hasDuplicateCharacter(bundle, picked)) continue;
        // 技能基准只跟成员卡有关（留影不参与评分模型），每套成员组合算一次
        const skills = deckSkillBaseline(bundle, picked, baseline);
        const meanSkill = skillMean(skills, skills.length);
        for (const snapSet of supportCombos) {
            const powerFree = deckPower(bundle, {
                members: picked,
                supports: snapSet,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
            }).total;
            const bonus = eventBonus(bundle, eventId, picked, snapSet);
            rows.push({
                members: picked,
                supports: snapSet,
                powerFree,
                powerChallenge: null,
                eventPt: bonus.total.eventPt,
                shopPt: bonus.total.shopPt,
                paramRate: bonus.total.parameter,
                skillMean: meanSkill,
            });
        }
    }
    return rows;
}

/**
 * `full` 档的队长试位：队长技能只由队首那张卡决定，而卡序又决定「成员 i ↔ 留影 i」的配对，
 * 所以逐个试「谁当队长」（只换顺序、不换卡），取综合力最高的排法。
 *
 * 只对候选集做（几百套 × 5 次），不做全枚举。挑战榜要连 parameter 加成一起算，
 * 所以 perMember/perSupport 也得跟着新卡序重算。
 */
function refineLeader(
    bundle: MasterBundle,
    eventId: number,
    input: OptimizeInput,
    rows: DeckRow[],
    characterRanks: Map<number, number>,
    bandItemLevels: Map<number, number>,
    precision: DeckPrecision,
    challenge: boolean
): DeckRow[] {
    if (precision !== 'full') return rows;
    return rows.map(row => {
        const powerOf = (members: OwnedMember[], supports: OwnedSupport[]): number => {
            const bonus = challenge ? eventBonus(bundle, eventId, members, supports) : undefined;
            return deckPower(bundle, {
                members,
                supports,
                characterRanks,
                bandItemLevels,
                precision,
                tgwCardRank: input.tgwCardRank,
                ...(bonus ? { bonus: { perMember: bonus.perMember, perSupport: bonus.perSupport } } : {}),
            }).total;
        };
        let bestMembers = row.members;
        let bestPower = powerOf(row.members, row.supports);
        for (const m of row.members) {
            const ordered = [m, ...row.members.filter(x => x !== m)];
            const power = powerOf(ordered, row.supports);
            if (power > bestPower) {
                bestPower = power;
                bestMembers = ordered;
            }
        }
        return challenge
            ? { ...row, members: bestMembers, powerChallenge: bestPower }
            : { ...row, members: bestMembers, powerFree: bestPower };
    });
}

/**
 * ② 四维 Pareto：按 (power, power×技能均值, eventPt, shopPt) 剔掉被支配的编队。
 *
 * 得分 = power·base + (power·技能均值)·ΣW，两个 power 轴对收益都单调（base、ΣW ≥ 0），
 * 两个加成是线性乘子 ⇒ 被支配的队在任何歌、任何表上都不可能赢 —— 仍是**精确**剪枝。
 * 方案0 的技能均值是常数（统一 60%），boost 轴与 power 轴同步，退化成原三维支配。
 * 再额外保留几个单项前几（全量档逐歌综合力会变，给精修留余地）。
 */
function tightenCandidates(rows: DeckRow[], powerOf: (r: DeckRow) => number, sigOf: (r: DeckRow) => string): DeckRow[] {
    // 先按 (power, boost, eventPt, shopPt [, 全量档的逐歌加成签名]) 去重：这几万套里大量组合的判定数完全一样，
    // 后面每一套都要跟前沿逐个比，去重能把 Pareto 那一趟的成本压下一个数量级。
    const unique = new Map<string, { row: DeckRow; power: number; boost: number }>();
    for (const row of rows) {
        const power = powerOf(row);
        const boost = power * row.skillMean;
        const key = `${power}|${boost}|${row.eventPt}|${row.shopPt}|${sigOf(row)}`;
        if (!unique.has(key)) unique.set(key, { row, power, boost });
    }
    type Entry = { row: DeckRow; power: number; boost: number };
    const dominates = (f: Entry, e: Entry): boolean =>
        f.power >= e.power && f.boost >= e.boost && f.row.eventPt >= e.row.eventPt && f.row.shopPt >= e.row.shopPt;
    const entries = [...unique.values()];
    entries.sort((a, b) => b.power - a.power || b.boost - a.boost || b.row.eventPt - a.row.eventPt || b.row.shopPt - a.row.shopPt);
    const front: Entry[] = [];
    for (const entry of entries) {
        let dominated = false;
        for (const f of front) {
            if (dominates(f, entry)) {
                dominated = true;
                break;
            }
        }
        if (dominated) continue;
        for (let i = front.length - 1; i >= 0; i--) {
            if (dominates(entry, front[i])) front.splice(i, 1);
        }
        front.push(entry);
    }
    const keep = new Map<string, DeckRow>();
    const add = (row: DeckRow): void => {
        const key = deckKey(row);
        if (!keep.has(key)) keep.set(key, row);
    };
    for (const entry of front) add(entry.row);
    for (const entry of entries.slice(0, EXTRA_POWER_TOPS)) add(entry.row);
    for (const row of [...rows].sort((a, b) => b.eventPt - a.eventPt).slice(0, EXTRA_BONUS_TOPS)) add(row);
    for (const row of [...rows].sort((a, b) => b.shopPt - a.shopPt).slice(0, EXTRA_BONUS_TOPS)) add(row);
    return [...keep.values()];
}

/**
 * 挑战候选集：挑战的综合力含 parameter 加成，得把 bonus 传进 deckPower 才算得出。
 * 三维 Pareto 是在「自由综合力」上做的，不一定覆盖「加参数后」的前沿，所以再按
 * 「自由综合力 ×(1+参数加成)」与「参数加成」各补一批，一并送去算真实综合力。
 */
function challengeSeed(rows: DeckRow[], freeCandidates: DeckRow[]): DeckRow[] {
    const keep = new Map<string, DeckRow>();
    const add = (row: DeckRow): void => {
        const key = deckKey(row);
        if (!keep.has(key)) keep.set(key, row);
    };
    for (const row of freeCandidates) add(row);
    const byBoost = [...rows].sort(
        (a, b) =>
            b.powerFree * (1 + b.paramRate / 10000) - a.powerFree * (1 + a.paramRate / 10000) || b.powerFree - a.powerFree
    );
    for (const row of byBoost.slice(0, CHALLENGE_SEED_TOPS)) add(row);
    const byParam = [...rows].sort((a, b) => b.paramRate - a.paramRate || b.powerFree - a.powerFree);
    for (const row of byParam.slice(0, EXTRA_BONUS_TOPS)) add(row);
    return [...keep.values()];
}

/** 给挑战候选集补算含 parameter 加成的综合力 */
function withChallengePower(
    bundle: MasterBundle,
    eventId: number,
    input: OptimizeInput,
    rows: DeckRow[],
    characterRanks: Map<number, number>,
    bandItemLevels: Map<number, number>,
    precision: DeckPrecision
): DeckRow[] {
    return rows.map(row => {
        const bonus = eventBonus(bundle, eventId, row.members, row.supports);
        const power = deckPower(bundle, {
            members: row.members,
            supports: row.supports,
            characterRanks,
            bandItemLevels,
            precision,
            tgwCardRank: input.tgwCardRank,
            bonus: { perMember: bonus.perMember, perSupport: bonus.perSupport },
        }).total;
        return { ...row, powerChallenge: power };
    });
}

// ---------------------------------------------------------------- ③ 扫描

/** 方案2（曲长前 50）取几首（BGM 最短优先） */
const SHORT_SONG_TOP = 50;

/**
 * 方案4：**曲长优先的反查**。
 *
 * 取 BGM 最短的 topSongs 首；每首：
 *  ① 逐队（实际技能基准）定评级，得卡库天花板；
 *  ② 在「最高档 / 低一档」两个可达评级里，各挑 eventPt 最大、shopPt 最大的队伍（加成最高者）；
 *  ③ 两条候选按产出（报酬 ×(1+加成) × 局/时）比较，点与道具各留产出最高的一条。
 * 返回每首歌的草稿（≤2 条），交给 buildBoardDraft 出三张表（它按指标取该曲最优行）。
 */
function schemeFourLists(
    ladders: SongLadder[],
    candidates: DeckRow[],
    rewards: Map<number, Reward>,
    powerOf: (r: DeckRow) => number,
    skillsOf: (r: DeckRow) => number,
    topSongs: number
): Map<number, PickDraft[]> {
    const out = new Map<number, PickDraft[]>();
    if (!candidates.length || !rewards.size) return out;
    const chosen = [...ladders]
        .filter(l => l.levels.length && l.levels[0].musicMs > 0)
        .sort((a, b) => a.levels[0].musicMs - b.levels[0].musicMs || a.musicId - b.musicId)
        .slice(0, topSongs);

    for (const ladder of chosen) {
        const musicMs = ladder.levels[0].musicMs;
        const plays = 3600000 / (musicMs + OVERHEAD_MS);
        // 每队的最高评级（跨难度）
        const rankOf = new Map<DeckRow, number>();
        let ceiling = 0;
        for (const row of candidates) {
            const power = powerOf(row);
            const rates = ladderRates(ladder, skillsOf(row));
            let rank = 0;
            for (const level of ladder.levels) {
                const rate = rates[level.difficulty] ?? 0;
                if (rate > 0 && power * rate >= level.threshold && level.rankNumber > rank) rank = level.rankNumber;
            }
            rankOf.set(row, rank);
            if (rank > ceiling) ceiling = rank;
        }
        const tiers = [ceiling, ceiling - 1].filter(r => r >= 2 && rewards.has(r));
        if (!tiers.length) continue;

        /** 某档里加成最高的队 + 展示难度/所需综合力 */
        const pickTier = (tier: number, metric: 'pt' | 'items'): { deck: DeckRow; minPower: number; difficulty: number; displayLevel: number } | null => {
            let best: DeckRow | null = null;
            let bestBonus = -1;
            for (const row of candidates) {
                if ((rankOf.get(row) ?? 0) < tier) continue;
                const bonus = metric === 'pt' ? row.eventPt : row.shopPt;
                if (bonus > bestBonus) {
                    bestBonus = bonus;
                    best = row;
                }
            }
            if (!best) return null;
            const rates = ladderRates(ladder, skillsOf(best));
            let difficulty = -1;
            let minPower = Infinity;
            let displayLevel = 0;
            for (const level of ladder.levels) {
                if (level.rankNumber !== tier) continue;
                const rate = rates[level.difficulty] ?? 0;
                if (!(rate > 0)) continue;
                const need = Math.ceil(level.threshold / rate);
                if (level.difficulty > difficulty || (level.difficulty === difficulty && need < minPower)) {
                    difficulty = level.difficulty;
                    minPower = need;
                    displayLevel = level.displayLevel;
                }
            }
            if (difficulty < 0) return null;
            return { deck: best, minPower, difficulty, displayLevel };
        };

        const list: PickDraft[] = [];
        for (const metric of ['pt', 'items'] as const) {
            let bestDraft: PickDraft | null = null;
            let bestValue = -1;
            for (const tier of tiers) {
                const pick = pickTier(tier, metric);
                const reward = rewards.get(tier);
                if (!pick || !reward) continue;
                const bonus = metric === 'pt' ? pick.deck.eventPt : pick.deck.shopPt;
                const value = (metric === 'pt' ? reward.points : reward.itemsSum) * (1 + bonus / 10000) * plays;
                if (value <= bestValue) continue;
                bestValue = value;
                const rates = ladderRates(ladder, skillsOf(pick.deck));
                bestDraft = {
                    deck: pick.deck,
                    musicId: ladder.musicId,
                    difficulty: pick.difficulty,
                    displayLevel: pick.displayLevel,
                    playMs: musicMs + OVERHEAD_MS,
                    playsPerHour: plays,
                    rankNumber: tier,
                    power: powerOf(pick.deck),
                    rate: rates[pick.difficulty] ?? 0,
                    difficultyVariants: [pick.difficulty],
                    requiredPower: pick.minPower,
                    musicMs,
                    pointsPerPlay: reward.points,
                    itemsPerPlay: reward.itemsSum,
                    pointsPerHour: reward.points * (1 + pick.deck.eventPt / 10000) * plays,
                    itemsPerHour: reward.itemsSum * (1 + pick.deck.shopPt / 10000) * plays,
                    drops: reward.items,
                };
            }
            if (bestDraft) list.push(bestDraft);
        }
        if (list.length) out.set(ladder.musicId, list);
    }
    return out;
}

/**
 * 只对候选编队 × 候选歌曲算收益：每首歌先定「卡库天花板」（**逐队按各自的实际技能基准**判定），
 * 再只算天花板往下 RANK_BAND 档。两档混在同一个 Pareto 集合里按 (pt/时, 道具/时) 比较，
 * 低的评级凭更高加成照样能排前面。
 *
 * `skillsOf` 给出每套编队的技能基准**均值**（方案0 = 统一常数；方案1~3 = 逐卡 live 技能/50%）；
 * 评级判定与「所需综合力」都按各队自己的基准现算（minPower = ceil(threshold / rate)）。
 * `exactPower` 给了就按「编队 + 歌」取全量档逐歌精修后的综合力（键 = `${deckKey}|${musicId}`）。
 */
function sweep(
    candidates: DeckRow[],
    ladders: SongLadder[],
    rewards: Map<number, Reward>,
    powerOf: (r: DeckRow) => number,
    skillsOf: (r: DeckRow) => number,
    exactPower?: Map<string, number>
): Map<number, PickDraft[]> {
    const out = new Map<number, PickDraft[]>();
    if (!candidates.length || !rewards.size) return out;

    for (const ladder of ladders) {
        // 天花板：卡库在这首歌能到的最高评级；再往下只保留 RANK_BAND 档
        let ceiling = 0;
        const ranksOf = new Map<DeckRow, Map<number, number>>();
        for (const row of candidates) {
            const power = exactPower?.get(`${deckKey(row)}|${ladder.musicId}`) ?? powerOf(row);
            const ranks = ladderRanks(ladder, power, ladderRates(ladder, skillsOf(row)));
            ranksOf.set(row, ranks);
            for (const rank of ranks.values()) if (rank > ceiling) ceiling = rank;
        }
        const bandMin = ceiling - (RANK_BAND - 1);
        if (bandMin < 2) continue;

        const list: PickDraft[] = [];
        for (const row of candidates) {
            const power = exactPower?.get(`${deckKey(row)}|${ladder.musicId}`) ?? powerOf(row);
            const rates = ladderRates(ladder, skillsOf(row));
            const rankByDifficulty = ranksOf.get(row);
            if (!rankByDifficulty || !rankByDifficulty.size) continue;
            // 每个可出场评级的「所需综合力」= 同评级各难度里最小（并列取更高难度）
            const bestByRank = new Map<number, { minPower: number; level: LadderLevel }>();
            for (const level of ladder.levels) {
                if (level.rankNumber < bandMin) continue;
                if ((rankByDifficulty.get(level.difficulty) ?? 0) < level.rankNumber) continue;
                const rate = rates[level.difficulty] ?? 0;
                if (!(rate > 0)) continue;
                const minPower = Math.ceil(level.threshold / rate);
                const cur = bestByRank.get(level.rankNumber);
                if (!cur || minPower < cur.minPower || (minPower === cur.minPower && level.difficulty > cur.level.difficulty)) {
                    bestByRank.set(level.rankNumber, { minPower, level });
                }
            }
            // 从高评级往低扫：同一档报酬在多个难度都够时留下的已是更高难度（上面已按并列规则取好）
            for (const rankNumber of [...bestByRank.keys()].sort((a, b) => b - a)) {
                const reward = rewards.get(rankNumber);
                if (!reward) continue;
                const entry = bestByRank.get(rankNumber) as { minPower: number; level: LadderLevel };
                const variants = [...rankByDifficulty.entries()]
                    .filter(([, rank]) => rank === rankNumber)
                    .map(([difficulty]) => difficulty)
                    .sort((a, b) => b - a);
                const pointsPerHour = reward.points * (1 + row.eventPt / 10000) * entry.level.playsPerHour;
                const itemsPerHour = reward.itemsSum * (1 + row.shopPt / 10000) * entry.level.playsPerHour;
                paretoInsert(list, {
                    deck: row,
                    musicId: ladder.musicId,
                    difficulty: entry.level.difficulty,
                    displayLevel: entry.level.displayLevel,
                    playMs: entry.level.playMs,
                    playsPerHour: entry.level.playsPerHour,
                    rankNumber,
                    power,
                    rate: rates[entry.level.difficulty] ?? 0,
                    difficultyVariants: variants,
                    requiredPower: entry.minPower,
                    musicMs: entry.level.musicMs,
                    pointsPerPlay: reward.points,
                    itemsPerPlay: reward.itemsSum,
                    pointsPerHour,
                    itemsPerHour,
                    drops: reward.items,
                });
            }
        }
        if (list.length) out.set(ladder.musicId, list);
    }
    return out;
}

// ---------------------------------------------------------------- 出榜

function metricValue(draft: PickDraft, metric: EventMetric, ptMax: number, itemsMax: number): number {
    if (metric === 'pt') return draft.pointsPerHour;
    if (metric === 'items') return draft.itemsPerHour;
    return (ptMax > 0 ? draft.pointsPerHour / ptMax : 0) + (itemsMax > 0 ? draft.itemsPerHour / itemsMax : 0);
}

/** 同一首歌里某个指标最好的那条（固定次序：指标降 → pt 降 → 道具降 → 难度高优先） */
function bestOf(list: PickDraft[], metric: EventMetric, ptMax: number, itemsMax: number): PickDraft | null {
    let best: PickDraft | null = null;
    let bestValue = -Infinity;
    for (const draft of list) {
        const value = metricValue(draft, metric, ptMax, itemsMax);
        const better =
            !best ||
            value > bestValue + 1e-9 ||
            (Math.abs(value - bestValue) <= 1e-9 &&
                (draft.pointsPerHour > best.pointsPerHour ||
                    (draft.pointsPerHour === best.pointsPerHour &&
                        (draft.itemsPerHour > best.itemsPerHour ||
                            (draft.itemsPerHour === best.itemsPerHour && draft.difficulty > best.difficulty)))));
        if (better) {
            best = draft;
            bestValue = value;
        }
    }
    return best;
}

/** 出榜：一个 scope 的三张表（返草稿，物化时再补编队明细） */
function buildBoardDraft(
    scope: EventBoardScope,
    title: string,
    lists: Map<number, PickDraft[]>,
    songIds: number[],
    /** 可选：这里出现过的曲目不上榜（当前两榜各自取最优，传 null） */
    avoid: BoardDraft | null,
    topN: number
): BoardDraft {
    const allowed = new Set(songIds);
    const scoped = [...lists.entries()].filter(([musicId]) => allowed.has(musicId));

    // 归一化基准取该 scope 内所有 (编队,歌曲) 对的最大值 —— 不是只取入榜行的，免得「选谁取决于基准」
    let ptMax = 0;
    let itemsMax = 0;
    for (const [, list] of scoped) {
        for (const draft of list) {
            ptMax = Math.max(ptMax, draft.pointsPerHour);
            itemsMax = Math.max(itemsMax, draft.itemsPerHour);
        }
    }

    const used = new Set<number>();
    if (avoid) for (const table of avoid.tables) for (const pick of table.picks) used.add(pick.musicId);

    const tables = (['pt', 'items', 'sum'] as EventMetric[]).map(metric => {
        const bests: Array<{ musicId: number; draft: PickDraft; value: number }> = [];
        for (const [musicId, list] of scoped) {
            if (used.has(musicId)) continue;
            const draft = bestOf(list, metric, ptMax, itemsMax);
            if (draft) bests.push({ musicId, draft, value: metricValue(draft, metric, ptMax, itemsMax) });
        }
        bests.sort(
            (a, b) =>
                b.value - a.value ||
                b.draft.pointsPerHour - a.draft.pointsPerHour ||
                b.draft.itemsPerHour - a.draft.itemsPerHour ||
                a.musicId - b.musicId
        );
        return { metric, picks: bests.slice(0, topN).map(x => ({ musicId: x.musicId, draft: x.draft })) };
    });

    return { scope, title, ptMax, itemsMax, tables };
}

/** 榜单里出现过的曲目（给活动乐队榜去重用） */
function draftSongs(board: BoardDraft): Set<number> {
    const set = new Set<number>();
    for (const table of board.tables) for (const pick of table.picks) set.add(pick.musicId);
    return set;
}

/**
 * 全量档逐歌精修：typeBonus / 偏好曲跟着歌走，基准综合力选出来的榜在前几名可能换评级。
 * 只对入榜候选（及其所在歌的候选编队）重算「含歌综合力」，预算几十首歌 × 几十套编队。
 */
function refineSongs(
    bundle: MasterBundle,
    eventId: number,
    input: OptimizeInput,
    candidates: DeckRow[],
    lists: Map<number, PickDraft[]>,
    songs: Set<number>,
    ladderById: Map<number, SongLadder>,
    powerOf: (r: DeckRow) => number,
    skillsOf: (r: DeckRow) => number,
    characterRanks: Map<number, number>,
    bandItemLevels: Map<number, number>,
    /** 挑战模式要带上 parameter 加成 */
    challenge: boolean,
    out: Map<string, number>
): void {
    const byPower = [...candidates].sort((a, b) => powerOf(b) - powerOf(a));
    for (const musicId of songs) {
        const ladder = ladderById.get(musicId);
        if (!ladder) continue;
        // 精修集合：该曲候选（Pareto 集）+ 基准综合力前若干 + **基准评级离天花板不超过 RANK_BAND 档的队**。
        // 最后这条不能省：逐歌精修后综合力会涨几个百分点，可能刚好把某队顶上一档
        //（实测过：基准 398,056 → 该曲 414,649，C 档升 B 档），只按基准综合力取前几名会把它漏掉。
        // 天花板逐队按各自的实际技能基准判定（方案1~3 各队基准不同）。
        let ceiling = 0;
        const bestRank = new Map<DeckRow, number>();
        for (const row of candidates) {
            let rank = 0;
            for (const r of ladderRanks(ladder, powerOf(row), ladderRates(ladder, skillsOf(row))).values()) {
                if (r > rank) rank = r;
            }
            bestRank.set(row, rank);
            if (rank > ceiling) ceiling = rank;
        }
        const nearMin = ceiling - RANK_BAND;
        const picked = new Map<string, DeckRow>();
        for (const draft of lists.get(musicId) ?? []) picked.set(deckKey(draft.deck), draft.deck);
        for (const row of byPower.slice(0, REFINE_DECKS)) picked.set(deckKey(row), row);
        for (const row of candidates) {
            const rank = bestRank.get(row) ?? 0;
            if (rank >= nearMin && rank > 0) picked.set(deckKey(row), row);
        }
        for (const row of picked.values()) {
            const bonus = challenge ? eventBonus(bundle, eventId, row.members, row.supports) : undefined;
            const power = deckPower(bundle, {
                members: row.members,
                supports: row.supports,
                characterRanks,
                bandItemLevels,
                precision: 'full',
                tgwCardRank: input.tgwCardRank,
                song: { musicType: ladder.musicType, bestMusicTagIDs: ladder.bestMusicTagIDs },
                ...(bonus ? { bonus: { perMember: bonus.perMember, perSupport: bonus.perSupport } } : {}),
            }).total;
            out.set(`${deckKey(row)}|${musicId}`, power);
        }
    }
}

// ---------------------------------------------------------------- 对外入口

export function optimizeEvent(input: OptimizeInput, event: OptimizeEvent): OptimizeResult {
    const { bundle, charts } = input;
    const precision: DeckPrecision = input.precision ?? 'precise';
    const scheme: DeckScheme = input.scheme ?? 3;
    const baseline = baselineForScheme(scheme, precision, input.skillBaselinePercent);
    const notes: string[] = [];

    const members = input.cards.members.map(m => ({ cardId: m[0], level: m[1], training: m[2], awakening: m[3], liveSkillLevel: m[4] }));
    const supports = input.cards.supports.map(s => ({ cardId: s[0], level: s[1], limitBreak: s[2] }));
    const characterRanks = new Map(input.cards.characters.map(c => [c[0], c[1]]));
    const bandItemLevels = new Map(input.items.bandItems.map(b => [b[0], b[1]]));

    if (members.length < DECK_SIZE) {
        return { mode: 'event', decks: [], songs: [], combos: [], boards: [], notes: ['成员卡不足 5 张，组不了队。'] };
    }

    notes.push('这是**启发式推荐**：先从卡库按单卡价值筛出候选、再在小候选池上穷举组合，不保证全局最优解。');
    notes.push(skillBaselineNote(scheme, precision, input.skillBaselinePercent));
    if (baseline === 'live' && !liveSkillsAvailable(bundle)) notes.push(LIVE_DEGRADED_NOTE);

    const freeRewards = toRewardMap(event.liveRewards);
    const challengeRewards = toRewardMap(event.challengeRewards ?? []);
    const bonusBandIds = new Set(event.bonusBandIds ?? []);

    // ---- 卡库剪枝（以用户卡库为界） ----
    const memberValue = (m: OwnedMember): number => {
        const own = memberPower(bundle, m)?.total ?? 0;
        const b = eventBonus(bundle, event.eventId, [m], []);
        return own * (1 + (b.total.parameter + b.total.eventPt + b.total.shopPt) / 10000);
    };
    const supportValue = (s: OwnedSupport): number => {
        const rates = supportRates(bundle, s);
        const own = rates[0] + rates[1] + rates[2];
        const b = eventBonus(bundle, event.eventId, [], [s]);
        return own * (1 + (b.total.parameter + b.total.eventPt + b.total.shopPt) / 10000);
    };
    const memberPool = buildMemberPool(bundle, members, memberValue);
    const supportCombos = buildSupportCombos(bundle, supports, supportValue);

    // ---- 排名基准（选池/效率用） ----
    // 基准是常数时它本身就是最准的排名基准（各队基准一致，评级判定精确）；
    // 基准逐卡（方案1~3 的全量档）时取成员池的**权力加权中位数** —— 只影响「哪些歌进混池」，
    // 评级与所需综合力一律走各队实际基准。
    const referenceMean = Array.isArray(baseline)
        ? baseline.reduce((a, b) => a + b, 0) / baseline.length
        : typeof baseline === 'number'
          ? baseline
          : weightedMedianBaseline(bundle, memberPool);

    // ---- 谱面阶梯与候选歌曲（自由=混池；挑战=仅活动曲） ----
    const ladders = buildLadder(bundle, charts, referenceMean);
    const ladderById = new Map(ladders.map(l => [l.musicId, l]));
    // 方案2 = 全曲：跳过「乐团×属性各取前几」的混池启发式
    const poolIds = scheme === 2 ? ladders.map(l => l.musicId) : pickSongPool(ladders);
    const bandIds = poolIds.filter(id => bonusBandIds.has(ladderById.get(id)?.bandId ?? 0));
    const challengeIds = (event.challengeMusicIds ?? []).filter(id => ladderById.has(id));
    const missingChallenge = (event.challengeMusicIds ?? []).filter(id => !ladderById.has(id));

    notes.push(
        `参与枚举：成员卡 ${memberPool.length}/${members.length} 张、留影组合 ${supportCombos.length} 组；` +
            `候选歌曲：${scheme === 2 ? '全曲' : '混池'} ${poolIds.length} 首` +
            `${scheme === 2 ? '' : `（乐团×属性各取效率前 ${SONG_PER_GROUP}）`}、` +
            `活动乐队 ${bandIds.length} 首、挑战曲 ${challengeIds.length} 首。`
    );

    // ---- ① 枚举 ----
    const rows = enumerateDecks(bundle, event.eventId, input, memberPool, supportCombos, characterRanks, bandItemLevels, precision, baseline);
    // 全量档下同一组 (power, 加成) 可能对应「逐歌综合力」不同的队（类型加成/偏好曲跟着歌走），
    // 所以去重键在全量档要带上成员的 属性+标签 签名，免得把对某首歌更合适的队合掉。
    const cardMeta = new Map(bundle.mcards.map(c => [c[0], { type: c[6], tags: c[13] }]));
    const sigOf =
        precision === 'full'
            ? (row: DeckRow): string =>
                  row.members.map(m => `${cardMeta.get(m.cardId)?.type ?? 0}:${(cardMeta.get(m.cardId)?.tags ?? []).join('.')}`).join(',')
            : (): string => '';
    // ---- ② 队长试位（full 档，只对候选集）+ 三维 Pareto 剪枝（精确） ----
    const freeCandidates = tightenCandidates(
        refineLeader(bundle, event.eventId, input, tightenCandidates(rows, r => r.powerFree, sigOf), characterRanks, bandItemLevels, precision, false),
        r => r.powerFree,
        sigOf
    );
    const challengeCandidates =
        challengeRewards.size && challengeIds.length
            ? tightenCandidates(
                  refineLeader(
                      bundle,
                      event.eventId,
                      input,
                      tightenCandidates(
                          withChallengePower(
                              bundle,
                              event.eventId,
                              input,
                              challengeSeed(rows, freeCandidates),
                              characterRanks,
                              bandItemLevels,
                              precision
                          ),
                          r => r.powerChallenge ?? 0,
                          sigOf
                      ),
                      characterRanks,
                      bandItemLevels,
                      precision,
                      true
                  ),
                  r => r.powerChallenge ?? 0,
                  sigOf
              )
            : [];
    notes.push(`枚举编队 ${rows.length} 套 → 全池候选 ${freeCandidates.length} 套、挑战候选 ${challengeCandidates.length} 套（支配剪枝后）。`);

    // ---- ③ 扫描 ----
    const freeLadders = poolIds.map(id => ladderById.get(id) as SongLadder);
    const challengeLadders = challengeIds.map(id => ladderById.get(id) as SongLadder);
    const listById = (ids: number[], lists: Map<number, PickDraft[]>): Map<number, PickDraft[]> =>
        new Map(ids.filter(id => lists.has(id)).map(id => [id, lists.get(id) as PickDraft[]]));

    const challengePowerOf = (r: DeckRow): number => r.powerChallenge ?? 0;
    /** 每套编队的技能基准均值（评级判定 / 所需综合力用）——方案0 是常数，方案1~4 逐卡 */
    const skillsOf = (r: DeckRow): number => r.skillMean;
    let freeLists: Map<number, PickDraft[]>;
    let challengeLists = new Map<number, PickDraft[]>();

    let scheme2BandLists = new Map<number, PickDraft[]>();
    if (scheme === 2) {
        // ---- 方案4：曲长最短 topSongs 首 × 两档加成队（不做精修，直接出榜） ----
        freeLists = schemeFourLists(ladders, freeCandidates, freeRewards, r => r.powerFree, skillsOf, SHORT_SONG_TOP);
        poolIds.length = 0;
        poolIds.push(...freeLists.keys());
        // 自由·活动加成乐队：只在加成乐队曲目里取（曲长前 topSongs）
        if (bandIds.length) {
            const bandSet = new Set(bandIds);
            scheme2BandLists = schemeFourLists(
                ladders.filter(l => bandSet.has(l.musicId)),
                freeCandidates,
                freeRewards,
                r => r.powerFree,
                skillsOf,
                SHORT_SONG_TOP
            );
        }
        // 挑战live：挑战曲 × 挑战报酬 × 含 parameter 加成的综合力
        if (challengeIds.length && challengeRewards.size) {
            const challengeSet = new Set(challengeIds);
            challengeLists = schemeFourLists(
                ladders.filter(l => challengeSet.has(l.musicId)),
                challengeCandidates,
                challengeRewards,
                challengePowerOf,
                skillsOf,
                SHORT_SONG_TOP
            );
        }
        notes.push(
            `方案2（曲长优先）：取 BGM 最短的 ${SHORT_SONG_TOP} 首，逐首在「最高档 / 低一档」两个可达评级里` +
                '各挑加成最高的队（点/道具分别挑），再按实际产出排序；活动乐队/挑战live 另按各自曲目与报酬表同法计算。'
        );
    } else {
        freeLists = sweep(freeCandidates, freeLadders, freeRewards, r => r.powerFree, skillsOf);
        challengeLists = sweep(challengeCandidates, challengeLadders, challengeRewards, challengePowerOf, skillsOf);
    }

    // ---- 全量档：对入榜候选逐歌精修后再扫一遍（方案4 不走精修） ----
    if (precision === 'full' && scheme !== 4) {
        // 精修集合按「每个表多取几名」来定 —— 只取最终那一行的话，第 2 名在精修后反超就没机会被算准。
        const provisionalFreeAll = buildBoardDraft('free-all', '', listById(poolIds, freeLists), poolIds, null, FREE_ALL_TOP);
        const provisionalBand = bandIds.length
            ? buildBoardDraft('free-band', '', listById(bandIds, freeLists), bandIds, provisionalFreeAll, REFINE_TOPS)
            : null;
        const provisionalChallenge = challengeIds.length
            ? buildBoardDraft('challenge', '', challengeLists, challengeIds, null, challengeIds.length)
            : null;
        const refineFree = new Set<number>(
            [...draftSongs(provisionalFreeAll), ...(provisionalBand ? draftSongs(provisionalBand) : [])]
        );
        const refineChallenge = provisionalChallenge ? draftSongs(provisionalChallenge) : new Set<number>();
        const exactFree = new Map<string, number>();
        const exactChallenge = new Map<string, number>();
        if (refineFree.size) {
            refineSongs(bundle, event.eventId, input, freeCandidates, freeLists, refineFree, ladderById, r => r.powerFree, skillsOf, characterRanks, bandItemLevels, false, exactFree);
        }
        if (refineChallenge.size) {
            refineSongs(bundle, event.eventId, input, challengeCandidates, challengeLists, refineChallenge, ladderById, challengePowerOf, skillsOf, characterRanks, bandItemLevels, true, exactChallenge);
        }
        if (exactFree.size) freeLists = sweep(freeCandidates, freeLadders, freeRewards, r => r.powerFree, skillsOf, exactFree);
        if (exactChallenge.size) {
            // 精修过的歌重建 Pareto；没精修的歌沿用上一遍的结果
            const rescanned = sweep(challengeCandidates, challengeLadders, challengeRewards, challengePowerOf, skillsOf, exactChallenge);
            for (const [musicId, list] of rescanned) challengeLists.set(musicId, list);
        }
    }

    // ---- 出榜 ----
    const freeScoped = listById(poolIds, freeLists);
    const boardsDrafts: BoardDraft[] = [];
    const freeAll = buildBoardDraft(
        'free-all',
        scheme === 4 ? `自由live · 曲长前 ${SHORT_SONG_TOP}（方案2）` : '自由live · 全曲池',
        freeScoped,
        poolIds,
        null,
        scheme === 4 ? FREE_ALL_TOP * 2 : FREE_ALL_TOP
    );
    boardsDrafts.push(freeAll);
    const bandLists = scheme === 4 ? scheme2BandLists : freeLists;
    if (bandIds.length && bandLists.size) {
        // 两榜**各自取最优**、允许重复（用户口径）：乐队榜不排除混池已上榜的曲目
        boardsDrafts.push(
            buildBoardDraft(
                'free-band',
                scheme === 4 ? `自由live · 活动加成乐队 · 曲长前 ${SHORT_SONG_TOP}（方案2）` : '自由live · 活动加成乐队',
                listById(bandIds, bandLists),
                bandIds,
                null,
                1
            )
        );
    } else {
        notes.push('本次活动没有加成乐队曲目（或曲目不在效率数据里），「活动乐队」那组榜不出。');
    }
    if (challengeIds.length && challengeLists.size) {
        boardsDrafts.push(
            buildBoardDraft(
                'challenge',
                scheme === 4 ? '挑战live · 活动挑战曲（方案2）' : '挑战live · 活动挑战曲',
                challengeLists,
                challengeIds,
                null,
                1
            )
        );
    } else {
        notes.push('本次活动没有可用的挑战曲（挑战曲未进效率数据，或活动没有挑战演出），挑战live 榜不出。');
    }
    if (missingChallenge.length) {
        notes.push(
            `活动挑战曲 ${missingChallenge.join(', ')} 暂无谱面模拟数据（缺技能权重与评级门槛），本次不出行；等 music-data 更新后可纳入。`
        );
    }

    // ---- 物化：每行自带一套编队（同一「编队+歌」只算一次 deckPower，明细给界面摊开） ----
    const deckCache = new Map<string, DeckSuggestion>();
    const materialize = (draft: PickDraft): DeckSuggestion => {
        // 同一套卡（卡序也相同）可能同时出现在自由与挑战两套候选里，而两边的综合力口径不同
        // （挑战含 parameter 加成）—— 缓存键必须带模式，不然挑战行会拿到自由那份明细。
        const challenge = draft.deck.powerChallenge !== null;
        const key = `${challenge ? 'c' : 'f'}|${deckKey(draft.deck)}|${draft.musicId}`;
        const cached = deckCache.get(key);
        if (cached) return cached;
        const ladder = ladderById.get(draft.musicId);
        const bonus = challenge ? eventBonus(bundle, event.eventId, draft.deck.members, draft.deck.supports) : undefined;
        const deckInput = {
            members: draft.deck.members,
            supports: draft.deck.supports,
            characterRanks,
            bandItemLevels,
            precision,
            tgwCardRank: input.tgwCardRank,
            ...(precision === 'full' && ladder
                ? { song: { musicType: ladder.musicType, bestMusicTagIDs: ladder.bestMusicTagIDs } }
                : {}),
            ...(bonus ? { bonus: { perMember: bonus.perMember, perSupport: bonus.perSupport } } : {}),
        };
        const suggestion: DeckSuggestion = {
            members: draft.deck.members,
            supports: draft.deck.supports,
            power: deckPower(bundle, deckInput),
            bonus: { eventPt: draft.deck.eventPt, shopPt: draft.deck.shopPt },
            score: draft.power,
        };
        deckCache.set(key, suggestion);
        return suggestion;
    };

    const decks: DeckSuggestion[] = [];
    const seenDeck = new Set<DeckSuggestion>();
    const boards: EventBoard[] = boardsDrafts.map(draft => {
        const tables: EventTable[] = draft.tables.map(table => ({
            metric: table.metric,
            rows: table.picks.map(pick => {
                const suggestion = materialize(pick.draft);
                if (!seenDeck.has(suggestion)) {
                    seenDeck.add(suggestion);
                    decks.push(suggestion);
                }
                return toEventPick(pick.draft, suggestion, draft.ptMax, draft.itemsMax);
            }),
        }));
        return { scope: draft.scope, title: draft.title, ptMax: draft.ptMax, itemsMax: draft.itemsMax, tables };
    });

    // 三条基准并成一条 —— 出图上注解太多，反而把表挤没了
    if (boards.length) {
        notes.push(
            '相加分基准（跨组不可比）：' +
                boards.map(b => `${b.title} 点数 ${fmt(b.ptMax)} / 道具 ${fmt(b.itemsMax)}`).join('；') +
                '。'
        );
    }
    notes.push(`评级只取每首歌天花板往下 ${RANK_BAND} 档，两档混算，低一档凭更高加成可以反超。`);

    return { mode: 'event', decks, songs: [], combos: [], boards, notes };
}

function toEventPick(draft: PickDraft, deck: DeckSuggestion, ptMax: number, itemsMax: number): EventPick {
    return {
        deck,
        musicId: draft.musicId,
        difficulty: draft.difficulty,
        difficultyLabel: DIFFICULTY_LABELS[draft.difficulty] ?? '?',
        difficultyVariants: draft.difficultyVariants,
        requiredPower: draft.requiredPower,
        musicMs: draft.musicMs,
        displayLevel: draft.displayLevel,
        rankNumber: draft.rankNumber,
        rankLabel: RANK_LABELS[draft.rankNumber] ?? '?',
        // 期望得分与 sweep 里判评级用的是同一套算法（expectedScore 的公式），逐位一致
        score: Math.floor(draft.power * draft.rate),
        power: draft.power,
        playMs: draft.playMs,
        playsPerHour: draft.playsPerHour,
        pointsPerPlay: draft.pointsPerPlay,
        itemsPerPlay: draft.itemsPerPlay,
        pointsPerHour: draft.pointsPerHour,
        itemsPerHour: draft.itemsPerHour,
        sumScore: metricValue(draft, 'sum', ptMax, itemsMax),
        drops: draft.drops.map(i => ({ name: i.name, perPlay: i.count })),
    };
}
