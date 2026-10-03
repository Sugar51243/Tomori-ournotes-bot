import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { cachedFetch } from '../cachedFetch';
import { logger } from '../../logger';
import { MusicData, MusicDataChartStat, MusicDataScoreRank, EfficiencyRow, RecommendRow } from '../../features/types/MusicData';

/**
 * 谱面效率数据客户端(storage.bdon.moe 的 music-data.json, 站点「歌曲meta」同源)。
 *
 * 原始文件约 13MB(85 首歌 × 4 难度, 每张谱面带全量模拟种子), 解析后只保留
 * 出图需要的字段 —— 完整 JSON 对象(上百 MB)不能常驻内存。
 */

/** 站点使用的默认结算耗时(秒): 效率分母 = BGM 时长 + 每局额外耗时 */
export const OVERHEAD_MS = 30000;
/** 默认技能百分比(站点预设「全 100」) */
export const DEFAULT_SKILL_PERCENT = 100;
/**
 * 默认技能: 五个槽位各 +100% 普通加分技能。
 * **这里是倍率不是百分比** —— 站点把输入的百分比在进模型前除 100(实测: 用百分数会把技能项放大 100 倍,
 * 出分变成几百, 与真实出分对不上), W 的定义本身就是「一个 +100% 技能多得的分数 ÷ 综合力」。
 */
export const DEFAULT_SKILLS = [1, 1, 1, 1, 1];

interface RawSong {
    id: number;
    bgm?: { length?: { durationMs?: number; lengthMs?: number } };
    charts?: RawChart[];
    scoreRanks?: RawScoreRank[];
}

interface RawChart {
    difficulty?: string;
    scoreId?: number;
    level?: number;
    displayLevel?: number;
    notes?: { judged?: number };
    bpm?: { main?: number };
    deck?: RawDeck;
}

interface RawScoreRank {
    rank?: string;
    requiredScore?: number;
    battleRequiredScore?: number;
}

interface RawSeed {
    score?: number;
    weights?: Array<Array<number | null> | undefined>;
}

interface RawDeck {
    unplayable?: boolean;
    positions?: number;
    seeds?: RawSeed[];
    offSeeds?: RawSeed[];
}

interface RawMusicData {
    format?: string;
    power?: { power?: number } | number;
    songs?: RawSong[];
    deck?: {
        model?: { power?: number };
        kinds?: Array<{ effectType?: number; skillTargetIds?: unknown[]; skillConditionGroup?: number; skillReleaseConditionGroup?: number; effectLimitCount?: number; effectExecuteLimitCount?: number; durationMs?: number; id?: number }>;
    };
}

let cached: MusicData | undefined;
let inflight: Promise<MusicData | undefined> | undefined;

function num(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** 普通加分技能(效果 2000)的种类 id —— 效率公式的 W 用它那套权重 */
function plainKindId(raw: RawMusicData): number {
    const kinds = raw.deck?.kinds ?? [];
    const plain = kinds.find(k => k.effectType === 2000
        && !(k.skillTargetIds ?? []).length
        && !k.skillConditionGroup
        && !k.skillReleaseConditionGroup
        && !k.effectLimitCount
        && !k.effectExecuteLimitCount
        && (k.durationMs ?? 5000) === 5000);
    return plain?.id ?? 0;
}

/** 一组种子的 base 与权重均值(种子缺失/字段缺失一律容错跳过) */
function statsOf(seeds: RawSeed[] | undefined, power: number, kindId: number): { base: number; weights: number[] } | undefined {
    if (!seeds?.length || !power) return undefined;
    let base = 0;
    const slotSums: number[] = [];
    let counted = 0;
    for (const seed of seeds) {
        const score = num(seed.score);
        if (score === undefined) continue;
        counted++;
        base += score / power;
        const w = seed.weights?.[kindId] ?? [];
        for (let i = 0; i < w.length; i++) {
            slotSums[i] = (slotSums[i] ?? 0) + (num(w[i]) ?? 0);
        }
    }
    if (!counted) return undefined;
    return {
        base: base / counted,
        weights: slotSums.map(s => s / counted)
    };
}

/** 解析并裁剪: 只留榜单需要的字段 */
function compact(raw: RawMusicData, kindId: number): MusicDataChartStat[] {
    const power = typeof raw.power === 'number' ? raw.power : (raw.power?.power ?? raw.deck?.model?.power ?? 0);
    const charts: MusicDataChartStat[] = [];
    for (const song of raw.songs ?? []) {
        const musicId = num(song.id);
        const bgmMs = num(song.bgm?.length?.durationMs) ?? num(song.bgm?.length?.lengthMs);
        if (musicId === undefined) continue;
        for (const c of song.charts ?? []) {
            const difficulty = c.difficulty;
            if (difficulty !== 'easy' && difficulty !== 'normal' && difficulty !== 'hard' && difficulty !== 'expert') continue;
            const scoreId = num(c.scoreId);
            const level = num(c.displayLevel) ?? num(c.level);
            if (scoreId === undefined || level === undefined || bgmMs === undefined || !c.deck) continue;
            const battle = statsOf(c.deck.seeds, power, kindId);
            const free = statsOf(c.deck.offSeeds, power, kindId);
            if (!battle && !free) continue;
            const scoreRanks = (song.scoreRanks ?? [])
                .filter((r): r is RawScoreRank & { rank: MusicDataScoreRank['rank'] } =>
                    r.rank === 'D' || r.rank === 'C' || r.rank === 'B' || r.rank === 'A' || r.rank === 'S' || r.rank === 'SS')
                .map(r => ({ rank: r.rank, requiredScore: num(r.requiredScore), battleRequiredScore: num(r.battleRequiredScore) }));
            charts.push({
                musicId,
                scoreId,
                difficulty,
                displayLevel: level,
                notes: num(c.notes?.judged) ?? 0,
                bpmMain: num(c.bpm?.main) ?? 0,
                bgmMs,
                unplayable: c.deck.unplayable === true,
                battle,
                free,
                scoreRanks
            });
        }
    }
    return charts;
}

/**
 * 取谱面效率数据(懒加载 + 模块级缓存; 磁盘缓存按 MUSIC_DATA_TTL_S 重验证)。
 * 上游不可用且无陈旧副本时返回 undefined, 由调用方按领域错误处理。
 */
export async function getMusicData(): Promise<MusicData | undefined> {
    if (cached) return cached;
    if (!inflight) {
        inflight = (async () => {
            const res = await cachedFetch(config.musicDataUrl, {
                key: 'music-data/music-data.json',
                ttlS: ttl.musicDataTtlS,
                allowStale: true,
                revalidate: true
            }).catch(() => undefined);
            if (!res) return undefined;
            try {
                const raw = JSON.parse(res.data.toString('utf8')) as RawMusicData;
                if (!Array.isArray(raw.songs)) return undefined;
                const charts = compact(raw, plainKindId(raw));
                cached = { format: String(raw.format ?? ''), charts, power: typeof raw.power === 'number' ? raw.power : (raw.power?.power ?? raw.deck?.model?.power ?? 0) };
                logger('musicData', `parsed ${charts.length} chart stats (${(res.data.length / 1024 / 1024).toFixed(1)}MB raw)`);
                return cached;
            } catch (e) {
                logger('musicData', `parse failed: ${e instanceof Error ? e.message : e}`);
                return undefined;
            }
        })().finally(() => { inflight = undefined; });
    }
    return inflight;
}

/** 分/综合力(出分): base + Σ 技能平均 × W_k */
export function rateOf(stat: { base: number; weights: number[] }, skills: number[]): number {
    const n = Math.min(stat.weights.length, skills.length);
    let sum = stat.base;
    for (let i = 0; i < n; i++) sum += skills[i] * stat.weights[i];
    return sum;
}

/** 分/综合力/分钟: 出分 ÷ ((BGM 时长 + 结算耗时) / 60000) */
export function perMinuteOf(rate: number, bgmMs: number, overheadMs: number = OVERHEAD_MS): number {
    return rate / ((bgmMs + overheadMs) / 60000);
}

/**
 * 活动推荐只收 HD / EX 两档难度(需求指定): 低难度门槛低但效率也低, 练度够的玩家都打这两档。
 * 带 `as const` 让 includes 收窄类型 —— 注意它只作用于 /eventRecommend, 不影响 /songMeta 的四难度混排。
 */
export const RECOMMEND_DIFFICULTIES = ['hard', 'expert'] as const;

/** 站点做支配比较时用的浮点容差 */
const DOM_EPS = 1e-12;
/** 支配比较的技能区间上界(站点固定用 150%) */
const DOM_XMAX = 1.5;

/**
 * 支配(与站点一致): a 支配 b —— 在技能 0%~150% 的任何取值下,
 * a 的分/综合力 与 分/综合力/分钟 都不低于 b, 且至少一项更高。
 * 时长(duration)为 0 时无法比较, 判为不支配。
 */
function dominates(a: EfficiencyRow, b: EfficiencyRow, xMax = DOM_XMAX): boolean {
    if (!(a.bgmMs > 0) || !(b.bgmMs > 0)) return false;
    let strict = false;
    for (const t of [0, xMax]) {
        const ra = a.base + t * a.sumW;
        const rb = b.base + t * b.sumW;
        for (const d of [ra - rb, ra / a.bgmMs - rb / b.bgmMs]) {
            const eps = DOM_EPS * Math.max(1, Math.abs(ra), Math.abs(rb));
            if (d < -eps) return false;
            if (d > eps) strict = true;
        }
    }
    return strict;
}

/**
 * 效率榜: 全部谱面按 分/综合力/分钟 降序取前 topN。
 *
 * 每行同时算出站点那两个**只在表格里展示**的派生值(需求要求参考但不画进图):
 * - 相对 relative: 该行效率 ÷ 榜首效率(100 = 与榜首持平)
 * - 支配 dominatedBy / 前沿 frontier: 被多少张谱面支配(两轴都不差于它); 0 = 在帕累托前沿上
 * 排序用「效率降序 -> 前沿优先 -> scoreId」, 与站点的排序口径一致(站点仅按效率 + scoreId, 前沿只作展示)。
 * 击奏榜跳过 unplayable 的谱面(第 4 个 Fever 游戏会出错), 自由榜不受影响。
 */
export function rankCharts(data: MusicData, mode: 'battle' | 'free', topN = 15, skills: number[] = DEFAULT_SKILLS): EfficiencyRow[] {
    const rows: EfficiencyRow[] = [];
    for (const c of data.charts) {
        if (mode === 'battle' && c.unplayable) continue;
        const model = mode === 'battle' ? c.battle : c.free;
        if (!model) continue;
        const rate = rateOf(model, skills);
        rows.push({
            ...c,
            rate,
            perMinute: perMinuteOf(rate, c.bgmMs),
            base: model.base,
            sumW: model.weights.reduce((a, b) => a + b, 0),
            relative: 0,
            dominatedBy: 0,
            frontier: false
        });
    }
    for (const row of rows) {
        row.dominatedBy = rows.filter(other => other !== row && dominates(other, row)).length;
        row.frontier = row.dominatedBy === 0;
    }
    rows.sort((a, b) => (b.perMinute - a.perMinute) || (Number(b.frontier) - Number(a.frontier)) || (a.scoreId - b.scoreId));
    const top = rows[0]?.perMinute ?? 0;
    for (const row of rows) row.relative = top > 0 ? row.perMinute / top : 0;
    return rows.slice(0, topN);
}

/**
 * 活动推荐曲: 按站点「活动 · 评级」算法, 为某个目标评级挑**所需综合力最低**的前 topN 张谱面。
 *
 * 所需综合力 = 该评级门槛 ÷ 分/综合力(理论上打到门槛分所需的综合力)。
 * 门槛按场景取: 击奏live 是房间全员得分之和的评级, 房间默认满员 5 人时门槛 = battleRequiredScore
 * (房间人数 n 时按 √(5/n) 缩放, 与站点一致); 自由live 用单人门槛 requiredScore。
 * 排序与站点一致: 所需综合力升序, 同值比 scoreId。
 */
export function recommendCharts(
    data: MusicData,
    mode: 'battle' | 'free',
    targetRank: MusicDataScoreRank['rank'],
    topN = 5,
    skills: number[] = DEFAULT_SKILLS,
    room = 5,
    /** 只统计这些曲目(挑战live 只能用活动曲); 省略 = 全部曲目 */
    onlyMusicIds?: number[]
): RecommendRow[] {
    const rows: RecommendRow[] = [];
    const allowed = onlyMusicIds ? new Set(onlyMusicIds) : undefined;
    for (const c of data.charts) {
        if (!(RECOMMEND_DIFFICULTIES as readonly string[]).includes(c.difficulty)) continue;
        if (allowed && !allowed.has(c.musicId)) continue;
        if (mode === 'battle' && c.unplayable) continue;
        const model = mode === 'battle' ? c.battle : c.free;
        if (!model) continue;
        const threshold = thresholdOf(c, mode, targetRank, room);
        if (threshold === null) continue;
        const rate = rateOf(model, skills);
        if (!(rate > 0)) continue;
        rows.push({
            musicId: c.musicId,
            difficulty: c.difficulty,
            displayLevel: c.displayLevel,
            notes: c.notes,
            bpmMain: c.bpmMain,
            bgmMs: c.bgmMs,
            targetRank,
            threshold,
            need: threshold <= 0 ? 0 : threshold / rate,
            // 局/小时 = 一小时(3.6e6 ms) ÷ 每局耗时(BGM 时长 + 结算耗时), 与站点同款
            perHour: c.bgmMs > 0 ? 3.6e6 / (c.bgmMs + OVERHEAD_MS) : undefined,
            source: 'musicdata'
        });
    }
    rows.sort((a, b) => ((a.need ?? Infinity) - (b.need ?? Infinity)) || (a.musicId - b.musicId) || a.difficulty.localeCompare(b.difficulty));
    return rows.slice(0, topN);
}

/** 该谱面在指定场景下的评级门槛; 没有该评级门槛返回 null */
function thresholdOf(chart: MusicDataChartStat, mode: 'battle' | 'free', rank: MusicDataScoreRank['rank'], room: number): number | null {
    const row = chart.scoreRanks.filter(r => r.rank === rank).pop();
    if (!row) return null;
    if (mode === 'free') return row.requiredScore ?? null;
    const battle = row.battleRequiredScore;
    if (battle === undefined) return null;
    // 房间 n 人: 每人所需分数 = √(5/n) × 门槛(站点同款, 取整到 1/n)
    const n = Math.min(5, Math.max(1, Math.round(room)));
    return n === 5 ? battle : Math.trunc(Math.sqrt(5 / n) * battle * n) / n;
}
