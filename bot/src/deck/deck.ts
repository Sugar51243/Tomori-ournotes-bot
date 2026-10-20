/**
 * ⚠ 移植自 web/client/src/accountPackage/deck.ts（网页组卡器）—— **保持同逻辑**：
 * 两边任何一边改了算法，另一边要同步（bot 侧 scripts/verify-deck-port.ts 用同一份样例
 * 数据对照数值）。除 import 来源与下方补充的类型别名外，不要改动运算本体 ——
 * 尤其是 bp（×10000）与 f32(Math.fround) 的往返，那是照游戏客户端舍入逐步对齐的。
 */
import type { MasterBundle, RateTriple, SupportCardTuple, MemberCardTuple } from './types';

/**
 * 组卡器的核心算术：卡力、队伍综合力、活动加成、期望得分。
 *
 * ⚠️ 这里的每一步都是**照抄参考站 on.tabsac.com 的实现**（`research/card_power.py` /
 * `research/deck_power.py`，其来源是 bdon 的 `cards/growth.ts` 与 Rust 侧模型），
 * 包括几个看起来多余的 float32 往返 —— 那不是笔误，是游戏客户端真的这么算的
 * （JS 的 number 是 float64，每个 float32 舍入点都得显式 `Math.fround` 还原）。
 * 改这里之前请先回去看那份实现，别凭直觉「化简」。
 *
 * 内部单位统一用 **bp = 点数 × 10000**：这样所有百分比运算都能在整数域里做完再落回点数，
 * 与参考实现一致。对外暴露的点数一律是 `bp / 10000` 取整。
 */

const UNIT = 10000;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

type Vec3 = RateTriple;

/**
 * 零向量。**冻结**：它会被当成「查不到就给个零」的默认值返回出去，
 * 一旦有谁往里面写，就会静默污染所有别的调用点（这个坑踩过一次）。
 * 冻上之后误写会直接抛错，而不是把数字悄悄算歪。
 */
const ZERO: Vec3 = Object.freeze([0, 0, 0]) as Vec3;

/** float32 舍入（对应参考实现的 _float32） */
const f32 = (v: number): number => Math.fround(v);

/** 向零截断的整数除法（对应 _trunc_div；注意不是 Python 的 //） */
function truncDiv(value: number, divisor: number): number {
    return value >= 0 ? Math.trunc(value / divisor) : -Math.trunc(-value / divisor);
}

/** 钳到 int32（对应 _floor_i32） */
function floorI32(value: number): number {
    if (Number.isNaN(value)) return 0;
    if (!Number.isFinite(value)) return I32_MIN;
    return Math.min(I32_MAX, Math.max(I32_MIN, Math.floor(value)));
}

/** bp → 落回 10000 的整数倍（对应 _to_floor_bp） */
function toFloorBp(value: number): number {
    return floorI32(f32(f32(value) / UNIT)) * UNIT;
}

function addVec(...vectors: Vec3[]): Vec3 {
    return [0, 1, 2].map(i => vectors.reduce((sum, v) => sum + v[i], 0)) as Vec3;
}

/**
 * 把一组 rate 应用到 bp 上（对应 _mul_floor）。
 * 先按整数截断做乘法，再落回 10000 的整数倍 —— 两步之间都有 float32 往返。
 */
function mulFloor(powerBp: Vec3, rates: Vec3): Vec3 {
    return [0, 1, 2].map(i => toFloorBp(truncDiv(powerBp[i] * rates[i], UNIT))) as Vec3;
}

/** 点数 → bp */
function toBp(points: Vec3): Vec3 {
    return [points[0] * UNIT, points[1] * UNIT, points[2] * UNIT];
}

/** bp → 点数（对应 _values(..., points=True)） */
function toPoints(vector: Vec3): Vec3 {
    return [floorI32(vector[0] / UNIT), floorI32(vector[1] / UNIT), floorI32(vector[2] / UNIT)];
}

const sum3 = (v: Vec3): number => v[0] + v[1] + v[2];

// ---------------------------------------------------------------- 卡力

/** 等级项的缩放：floor(fround(fround(rate × max) / 10000)) */
function scaleProductThenRatio(maximum: number, rate: number): number {
    return Math.floor(f32(f32(rate * maximum) / UNIT));
}

/** 特训项的缩放：floor(fround(fround(rate / 10000) × max)) —— **操作顺序与另两项相反** */
function scaleRatioThenProduct(maximum: number, rate: number): number {
    return Math.floor(f32(f32(rate / UNIT) * f32(maximum)));
}

/** 从导入记录里的一张成员卡还原出算卡力需要的字段 */
export interface OwnedMember {
    cardId: number;
    level: number;
    /** 特训次数 0..4 */
    training: number;
    /** 觉醒次数 0..4 */
    awakening: number;
    /**
     * live 技能等级 1..5（账号包成员卡的第 5 项）。全量档的技能基准按「该卡 live 技能在
     * 该等级的**无条件**得分比率」取值；缺省（旧数据/夹具）按 1 级算。
     */
    liveSkillLevel?: number;
}

export interface OwnedSupport {
    cardId: number;
    level: number;
    /** 限界突破次数 0..4 */
    limitBreak: number;
}

export interface MemberPowerDetail {
    /** 三项各自的三段明细，便于在界面上摊开说明 */
    terms: { level: Vec3; training: Vec3; awakening: Vec3 };
    parameters: Vec3;
    total: number;
}

const mcardById = (bundle: MasterBundle, id: number): MemberCardTuple | undefined =>
    bundle.mcards.find(c => c[0] === id);
const scardById = (bundle: MasterBundle, id: number): SupportCardTuple | undefined =>
    bundle.scards.find(c => c[0] === id);

/**
 * 取某组某下标的 rate。
 *
 * 下标越界时**钳到表尾**，不是返回零：数据快照比游戏旧时（新开了一级、或某张表的
 * 组少了几档），返回零会把这张卡的整项加成静默抹掉，算出来的综合力偏低还看不出错。
 * 取最接近的一档是更保守的近似。整组都缺才回零向量。
 */
function rateAt(table: Record<string, RateTriple[]>, group: number, index: number): Vec3 {
    const list = table[String(group)];
    if (!list || !list.length) return ZERO;
    return list[Math.min(Math.max(index, 0), list.length - 1)];
}

/** 成员卡自身的卡力（不含任何队伍加成） */
export function memberPower(bundle: MasterBundle, owned: OwnedMember): MemberPowerDetail | null {
    const card = mcardById(bundle, owned.cardId);
    if (!card) return null;
    const [, , , , , , , levelGroup, awakeGroup, rankGroup, pMax, tMax, vMax] = card;
    const maxes: Vec3 = [pMax, tMax, vMax];

    const levelRate = rateAt(bundle.memberLevelRates, levelGroup, Math.max(0, owned.level - 1));
    const awakeRate = rateAt(bundle.memberAwakeRates, awakeGroup, owned.training);
    const rankRate = rateAt(bundle.memberRankRates, rankGroup, owned.awakening);

    // ⚠️ 每项必须是**各自的**数组。写成 `{level: ZERO, training: ZERO, …}` 会让三个键
    // 指向同一个数组：循环里互相覆写，既算错又会被改写掉模块级的 ZERO，
    // 把 ZERO 的其它用处一起带坏。踩过一次。
    const terms: MemberPowerDetail['terms'] = { level: [0, 0, 0], training: [0, 0, 0], awakening: [0, 0, 0] };
    const parameters: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        terms.level[i] = scaleProductThenRatio(maxes[i], levelRate[i]);
        terms.training[i] = scaleRatioThenProduct(maxes[i], awakeRate[i]);
        terms.awakening[i] = scaleProductThenRatio(maxes[i], rankRate[i]);
        parameters[i] = terms.level[i] + terms.training[i] + terms.awakening[i];
    }
    return { terms, parameters, total: sum3(parameters) };
}

/** 留影卡的支援率（单位 10000 = 100%） */
export function supportRates(bundle: MasterBundle, owned: OwnedSupport): Vec3 {
    const card = scardById(bundle, owned.cardId);
    if (!card) return ZERO;
    const [, , , , , levelGroup, , pMax, tMax, vMax] = card;
    const maxes: Vec3 = [pMax, tMax, vMax];
    const levelRate = rateAt(bundle.supportLevelRates, levelGroup, Math.max(0, owned.level - 1));
    return [0, 1, 2].map(i => scaleProductThenRatio(maxes[i], levelRate[i])) as Vec3;
}

/** 等级上限（特训次数决定），导入时可以用来校验/提示 */
export function memberLevelCap(bundle: MasterBundle, cardId: number, training: number): number {
    const card = mcardById(bundle, cardId);
    if (!card) return 0;
    return bundle.memberLevelCap[String(card[5])]?.[training] ?? 0;
}

// ---------------------------------------------------------------- 乐队道具

// ---------------------------------------------------------------- 全量模型的几个加成

/**
 * 技能效果类型 → 作用在哪些轴上。
 * 1000 = 三维同加；1001/1002/1003 分别只加 technique / visual / performance。
 */
function effectAxes(effectType: number): number[] {
    if (effectType === 1000) return [0, 1, 2];
    if (effectType === 1001) return [1];
    if (effectType === 1002) return [2];
    if (effectType === 1003) return [0];
    return [];
}

function effectVec(effectType: number, value: number): Vec3 {
    const axes = effectAxes(effectType);
    return [axes.includes(0) ? value : 0, axes.includes(1) ? value : 0, axes.includes(2) ? value : 0];
}

/** 技能目标是否命中某张卡（对应参考实现的 `_target_matches`：命中**任意**一个选择器即可） */
function targetMatches(target: [number, number, number, number], card: MemberCardTuple, characterBandId: number): boolean {
    const [bandId, characterId, cardType, tagId] = target;
    return (
        (bandId > 0 && bandId === characterBandId) ||
        (characterId > 0 && characterId === card[4]) ||
        (cardType !== 0 && cardType === card[6]) ||
        (tagId > 0 && card[13].includes(tagId))
    );
}

/**
 * 每个位置能吃到多少队长技能加成。
 *
 * 队长技能只由**队长**那张卡决定，但效果可以打在满足条件的多张卡上
 * （目标为空 = 打全队）。所以返回的是 per-位置 的向量。
 */
export function leaderRates(
    bundle: MasterBundle,
    leader: MemberCardTuple,
    leaderSkillLevel: number,
    cards: Array<{ card: MemberCardTuple; bandId: number }>
): Vec3[] {
    const skillId = leader[14];
    if (!skillId) return cards.map(() => [0, 0, 0]);

    const rows = bundle.leaderSkillEffects.filter(r => r[0] === skillId && r[1] === leaderSkillLevel);
    const rates: Vec3[] = cards.map(() => [0, 0, 0]);
    for (const row of rows) {
        const vec = effectVec(row[2], row[3]);
        const targetIds = row.slice(4);
        const targets = targetIds
            .map(id => bundle.skillTargets[String(id)])
            .filter((t): t is [number, number, number, number] => !!t);
        for (let i = 0; i < cards.length; i++) {
            // 没有目标 = 打全队
            if (targets.length && !targets.some(t => targetMatches(t, cards[i].card, cards[i].bandId))) continue;
            rates[i] = addVec(rates[i], vec);
        }
    }
    return rates;
}

/** T.G.W CARD 的加成率（1 级无加成；上游对 1 级就不发这一档） */
function tgwRate(bundle: MasterBundle, vipRank: number): number {
    let rate = 0;
    for (const [rank, value] of bundle.tgwRates) if (vipRank >= rank) rate = value;
    return rate;
}

/**
 * 每张卡能吃到多少乐队道具加成。
 *
 * 规则（对应参考实现的 `_band_rates`）：只挑「效果目标能匹配到本队任意一张卡」的道具，
 * 且只算**已解锁（等级 ≥ 1）**的；每命中一个非零选择器就叠一份效果值。
 */
export function bandItemRates(
    bundle: MasterBundle,
    /** bandItemId → 等级（0 = 未解锁） */
    ownedLevels: Map<number, number>,
    cards: Array<{ card: MemberCardTuple; characterId: number; bandId: number }>
): Vec3[] {
    const rates: Vec3[] = cards.map(() => [0, 0, 0]);

    for (const [itemId, level] of ownedLevels) {
        if (level < 1) continue;
        const rows = bundle.bandItemEffects[String(itemId)];
        if (!rows) continue;
        // 同一道具同一等级只有一行，但保险起见按等级过滤
        const row = rows.find(r => r[0] === level);
        if (!row) continue;

        const value = row[1];
        const targetIds = row.slice(2);
        for (let i = 0; i < cards.length; i++) {
            const { card, characterId, bandId } = cards[i];
            let matches = 0;
            for (const tid of targetIds) {
                const target = bundle.skillTargets[String(tid)];
                if (!target) continue;
                const [tBand, tChar, tType] = target;
                // 参考实现：每个非零选择器各算一次命中，三者可叠加
                if (tBand > 0 && tBand === bandId) matches += 1;
                if (tChar > 0 && tChar === characterId) matches += 1;
                if (tType !== 0 && tType === card[6]) matches += 1;
            }
            if (matches > 0) rates[i] = addVec(rates[i], [value * matches, value * matches, value * matches]);
        }
    }
    return rates;
}

// ---------------------------------------------------------------- 活动加成

export interface EventBonus {
    /** 单位 10000 = 100% */
    eventPt: number;
    shopPt: number;
    /** 参数加成（作用在卡力上） */
    parameter: number;
}

const BONUS_EVENT_PT = 0;
const BONUS_SHOP_PT = 1;
const BONUS_PARAMETER = 2;

/** 一行活动条件的匹配（对应 `_matches_member` / `_matches_snap`） */
function matchMember(row: number[], card: MemberCardTuple, characterBandId: number): boolean {
    if (row[1] !== 2) return false;
    const [, , characterId, bandId, cardType, tagId, memberCardId] = row;
    if (characterId !== 0 && characterId !== card[4]) return false;
    if (bandId !== 0 && bandId !== characterBandId) return false;
    if (cardType !== 0 && cardType !== card[6]) return false;
    if (memberCardId !== 0 && memberCardId !== card[0]) return false;
    if (tagId !== 0 && !card[13].includes(tagId)) return false;
    return true;
}

function matchSupport(row: number[], card: SupportCardTuple, characterBands: Set<number>): boolean {
    if (row[1] !== 3) return false;
    const [, , characterId, bandId, cardType, tagId, , supportCardId] = row;
    // 参考实现：留影卡的条件不带 tagId
    if (tagId !== 0) return false;
    const characterIds = card[10];
    if (characterId !== 0 && !characterIds.includes(characterId)) return false;
    if (bandId !== 0 && !characterBands.has(bandId)) return false;
    if (cardType !== 0 && cardType !== card[4]) return false;
    if (supportCardId !== 0 && supportCardId !== card[0]) return false;
    return true;
}

/**
 * 队伍能吃到多少活动加成。
 *
 * 逐卡求值而不是整队求和：成员卡与留影卡的加成是分别算的，最后再相加。
 * 值直接相加、**不做四舍五入**（参考实现明确强调过）。
 */
export function eventBonus(
    bundle: MasterBundle,
    eventId: number,
    members: OwnedMember[],
    supports: OwnedSupport[]
): { total: EventBonus; perMember: EventBonus[]; perSupport: EventBonus[] } {
    const rows = bundle.eventEffects.filter(r => r[0] === eventId);
    const characterBand = new Map(bundle.chars.map(c => [c[0], c[2]]));

    const zero = (): EventBonus => ({ eventPt: 0, shopPt: 0, parameter: 0 });
    const perMember: EventBonus[] = members.map(() => zero());
    const perSupport: EventBonus[] = supports.map(() => zero());

    const add = (into: EventBonus, row: number[], rankIndex: number): void => {
        // 觉醒次数 +1 = 上游的 rank（1..5）
        const value = row[9 + rankIndex] ?? 0;
        const type = row[8];
        if (type === BONUS_EVENT_PT) into.eventPt += value;
        else if (type === BONUS_SHOP_PT) into.shopPt += value;
        else if (type === BONUS_PARAMETER) into.parameter += value;
    };

    for (let i = 0; i < members.length; i++) {
        const card = mcardById(bundle, members[i].cardId);
        if (!card) continue;
        const bandId = characterBand.get(card[4]) ?? -1;
        const rankIndex = Math.min(4, Math.max(0, members[i].awakening));
        for (const row of rows) if (matchMember(row, card, bandId)) add(perMember[i], row, rankIndex);
    }

    for (let i = 0; i < supports.length; i++) {
        const card = scardById(bundle, supports[i].cardId);
        if (!card) continue;
        const bands = new Set(card[10].map(cid => characterBand.get(cid) ?? -1));
        const rankIndex = Math.min(4, Math.max(0, supports[i].limitBreak));
        for (const row of rows) if (matchSupport(row, card, bands)) add(perSupport[i], row, rankIndex);
    }

    const total = zero();
    for (const b of [...perMember, ...perSupport]) {
        total.eventPt += b.eventPt;
        total.shopPt += b.shopPt;
        total.parameter += b.parameter;
    }
    return { total, perMember, perSupport };
}

// ---------------------------------------------------------------- 队伍综合力

/**
 * 计算精度。
 *
 * - `precise`：卡力 + 角色等级 + 留影 + 乐队道具（不依赖歌曲，任何歌都是同一个数）
 * - `full`：再加上队长技能、类型链接、T.G.W，以及**依赖歌曲**的类型加成与偏好曲
 *
 * 注意 `full` 下两个组件是跟着歌走的：类型加成看「卡的 cardType == 歌的 musicType」，
 * 偏好曲看「卡的 bestMusicTagIDs ∩ 歌的 bestMusicTagIDs」。所以全量模型的综合力
 * 对同一套队伍、不同的歌是不一样的 —— 这也是参考站那边 `calculate_deck_power` 必须传 song_id 的原因。
 */
export type DeckPrecision = 'precise' | 'full';

export interface DeckInput {
    members: OwnedMember[];
    supports: OwnedSupport[];
    /** 角色等级（来自导入记录） */
    characterRanks: Map<number, number>;
    /** bandItemId → 等级 */
    bandItemLevels: Map<number, number>;
    /** 活动加成；不传 = 普通模式 */
    bonus?: { perMember: EventBonus[]; perSupport: EventBonus[] };
    /** 精度档位，默认 precise */
    precision?: DeckPrecision;
    /** 队长（成员卡 id）；不给就用第一张 */
    leaderMemberId?: number;
    /** T.G.W CARD 等级（来自导入记录）。全量模型才用 */
    tgwCardRank?: number;
    /**
     * 正在打的歌。**全量模型必填**（类型加成与偏好曲要它），
     * precise 档传了也不影响结果。
     */
    song?: { musicType: number; bestMusicTagIDs: number[] };
}

export interface DeckPower {
    /** 队伍总综合力（点数） */
    total: number;
    /** 每张卡的明细，便于界面摊开 */
    slots: Array<{
        member: MemberPowerDetail;
        own: number;
        characterRank: number;
        support: number;
        bandItem: number;
        total: number;
        /** 该位吃到的支援率/道具率，单位 10000 */
        rates: { support: Vec3; bandItem: Vec3 };
    }>;
    components: Record<string, number>;
}

/**
 * 一套队伍的综合力。
 *
 * 每个位置的算式（对应参考实现 deck_power.py 的组合段）：
 *   base              = 卡自身卡力 ×(1 + 该卡的活动参数加成)
 *   character_flat    = 角色等级加成 + 角色总等级加成（平坦加到三项上）
 *   calculation_base  = base + character_flat
 *   支援/道具项        = calculation_base × 各自的 rate
 *   位置合计           = base + character_flat + 支援 + 道具 +（全量模式的其余项）
 *
 * 本轮只实现「精确」档：卡力 + 角色等级 + 留影卡 + 乐队道具。
 * 队长技能 / 类型链接 / 类型加成 / 偏好曲 / T.G.W 属于「全量」档，见 `bonusComponents`。
 */
export function deckPower(bundle: MasterBundle, input: DeckInput): DeckPower {
    const characterBand = new Map(bundle.chars.map(c => [c[0], c[2]]));

    // 角色总等级加成：取 totalRank ≤ 实际值里最大的一档
    const totalRank = [...input.characterRanks.values()].reduce((a, b) => a + b, 0);
    let totalRankBonus = 0;
    for (const [need, bonus] of bundle.charTotalRank) if (totalRank >= need) totalRankBonus = bonus;

    const cardInfos = input.members.map(m => {
        const card = mcardById(bundle, m.cardId);
        const characterId = card?.[4] ?? -1;
        return { card: card as MemberCardTuple, characterId, bandId: characterBand.get(characterId) ?? -1 };
    });
    const validCards = cardInfos.filter(i => i.card);
    const bandRates = bandItemRates(
        bundle,
        input.bandItemLevels,
        validCards.map(i => ({ card: i.card, characterId: i.characterId, bandId: i.bandId }))
    );

    const full = input.precision === 'full';
    // 队长技能由队长那张卡决定，效果可能打在全队上 —— 先整队算一遍
    const leaderMember = input.members.find(m => m.cardId === input.leaderMemberId) ?? input.members[0];
    const leaderIndex = Math.max(0, input.members.findIndex(m => m === leaderMember));
    const leaderCard = leaderMember ? mcardById(bundle, leaderMember.cardId) : undefined;
    const leaderSkillLevel = leaderCard
        ? (bundle.memberRankExtras[String(leaderCard[9])]?.[leaderMember.awakening]?.[0] ?? 1)
        : 1;
    const leaderRatePerSlot =
        full && leaderCard
            ? leaderRates(bundle, leaderCard, leaderSkillLevel, cardInfos.filter(i => i.card))
            : input.members.map(() => ZERO);
    const tgw = full ? tgwRate(bundle, input.tgwCardRank ?? 1) : 0;

    const components: Record<string, number> = {
        members: 0,
        characterRank: 0,
        snaps: 0,
        bandItems: 0,
        leaderSkill: 0,
        typeLink: 0,
        typeBonus: 0,
        favoredMusic: 0,
        tgwCard: 0,
    };
    const slots: DeckPower['slots'] = [];

    for (let i = 0; i < input.members.length; i++) {
        const info = cardInfos[i];
        const memberDetail = memberPower(bundle, input.members[i]);
        if (!info.card || !memberDetail) continue;

        const ownBp = toBp(memberDetail.parameters);
        // 活动参数加成：只作用在卡自身卡力上
        const memberEventRate = input.bonus?.perMember[i]?.parameter ?? 0;
        const base = addVec(ownBp, mulFloor(ownBp, [memberEventRate, memberEventRate, memberEventRate]));

        // 角色等级是平坦加成：等级加成 + 总等级加成，三项各加一次
        const rank = input.characterRanks.get(info.characterId) ?? 1;
        const charBonus = bundle.charRank.bonus[Math.max(0, rank - 1)] ?? 0;
        const flat = (charBonus + totalRankBonus) * UNIT;
        const characterFlat: Vec3 = [flat, flat, flat];
        const calculationBase = addVec(base, characterFlat);

        // 支援率 + 该留影卡自己的活动参数加成
        const snapshot = input.supports[i];
        const baseSupportRate = snapshot ? supportRates(bundle, snapshot) : ZERO;
        const snapEventRate = input.bonus?.perSupport[i]?.parameter ?? 0;
        const supportRate: Vec3 = [
            baseSupportRate[0] + snapEventRate,
            baseSupportRate[1] + snapEventRate,
            baseSupportRate[2] + snapEventRate,
        ];
        const bandRate = bandRates[i] ?? ZERO;

        const snapVec = mulFloor(calculationBase, supportRate);
        const bandVec = mulFloor(calculationBase, bandRate);

        // ---- 全量模型独有的几项 ----
        // 队长技能
        const leaderVec = full ? mulFloor(calculationBase, leaderRatePerSlot[i] ?? ZERO) : ZERO;
        // 类型链接：卡的 cardType 与留影卡的 cardType 相同才生效
        const snapshotCard = snapshot ? scardById(bundle, snapshot.cardId) : undefined;
        // 留影卡的元组是 [id, assetID, 名idx, rarity, cardType, 等级组, 突破组, …]，
        // supportRank 按**突破组**（下标 6）索引 —— 别写成等级组。
        const linkRate =
            full && snapshotCard && snapshotCard[4] === info.card[6]
                ? bundle.rateBases.linkBase +
                  (bundle.supportRank[String(snapshotCard[6])]?.[snapshot?.limitBreak ?? 0]?.[5] ?? 0)
                : 0;
        const linkVec = full ? mulFloor(calculationBase, [linkRate, linkRate, linkRate]) : ZERO;
        // 类型加成：卡的 cardType 与歌的 musicType 相同（任一方为 99 也算通配）
        const musicType = input.song?.musicType ?? 0;
        const typeRate =
            full && input.song && (info.card[6] === 99 || musicType === 99 || info.card[6] === musicType)
                ? bundle.rateBases.typeBase +
                  (bundle.memberRankExtras[String(info.card[9])]?.[input.members[i].awakening]?.[1] ?? 0)
                : 0;
        const typeVec = full ? mulFloor(calculationBase, [typeRate, typeRate, typeRate]) : ZERO;
        // 偏好曲：卡的 bestMusicTagIDs 与歌的标签有交集
        const songTags = input.song?.bestMusicTagIDs ?? [];
        const tagRate =
            full && input.song && songTags.length && info.card[13].some(t => songTags.includes(t))
                ? bundle.rateBases.tagBase +
                  (bundle.memberRankExtras[String(info.card[9])]?.[input.members[i].awakening]?.[2] ?? 0)
                : 0;
        const tagVec = full ? mulFloor(calculationBase, [tagRate, tagRate, tagRate]) : ZERO;
        const tgwVec = full ? mulFloor(calculationBase, [tgw, tgw, tgw]) : ZERO;

        const slotBp = addVec(base, characterFlat, snapVec, bandVec, leaderVec, linkVec, typeVec, tagVec, tgwVec);

        const slot = {
            member: memberDetail,
            own: sum3(memberDetail.parameters),
            characterRank: Math.floor((flat / UNIT) * 3),
            support: Math.floor(sum3(snapVec) / UNIT),
            bandItem: Math.floor(sum3(bandVec) / UNIT),
            total: sum3(toPoints(slotBp)),
            rates: { support: supportRate, bandItem: bandRate },
        };
        slots.push(slot);

        components.members += sum3(toPoints(base));
        components.characterRank += Math.floor((flat / UNIT) * 3);
        components.snaps += slot.support;
        components.bandItems += slot.bandItem;
        components.leaderSkill += Math.floor(sum3(leaderVec) / UNIT);
        components.typeLink += Math.floor(sum3(linkVec) / UNIT);
        components.typeBonus += Math.floor(sum3(typeVec) / UNIT);
        components.favoredMusic += Math.floor(sum3(tagVec) / UNIT);
        components.tgwCard += Math.floor(sum3(tgwVec) / UNIT);
    }

    const total = slots.reduce((sum, s) => sum + s.total, 0);
    return { total, slots, components };
}

// ---------------------------------------------------------------- 得分与活动点

/** 一个谱面的效率数据（来自 /chart-efficiency） */
export interface ChartEfficiency {
    musicId: number;
    difficulty: number;
    bgmMs: number;
    notes: number;
    displayLevel: number;
    baseFree: number;
    weightsFree: number[];
    baseBattle: number;
    weightsBattle: number[];
    /** [评级数字, 分数线]，评级 2..7 = D..SS */
    ranks: Array<[number, number]>;
}

export const RANK_LABELS: Record<number, string> = { 2: 'D', 3: 'C', 4: 'B', 5: 'A', 6: 'S', 7: 'SS' };

/** 把 /chart-efficiency 的紧凑行摊成对象（行布局见 API 的类型定义） */
export function toChartEfficiency(row: readonly unknown[]): ChartEfficiency {
    return {
        musicId: row[0] as number,
        difficulty: row[1] as number,
        bgmMs: row[2] as number,
        notes: row[3] as number,
        displayLevel: row[4] as number,
        baseFree: row[6] as number,
        weightsFree: (row[7] ?? []) as number[],
        baseBattle: row[8] as number,
        weightsBattle: (row[9] ?? []) as number[],
        ranks: (row[10] ?? []) as Array<[number, number]>,
    };
}

/** 固定开销：每局除了歌曲本身还有约 30 秒的进出场时间 */
export const OVERHEAD_MS = 30000;

/**
 * 每张卡的演出技能加成。
 *
 * ⚠️ 这里用的是**游戏基础值 +100%**（对应 bot 侧 music-data 的 `DEFAULT_SKILLS`），
 * 不是各卡实际的技能倍率 —— 那需要再拉 MasterLiveSkill / MasterLiveSkillEffect 两张表。
 * 所有队伍都按同一个技能值估算，所以**队伍之间的比较是公平的**，
 * 但绝对分数会与实际有偏差。界面上要如实标注这一点。
 */
export const ASSUMED_SKILL_MULTIPLIER = 1;

/**
 * 技能基准（组卡搜索用）。
 *
 * 期望得分 = 综合力 × (base + 各槽基准的**均值** × ΣW) —— 技能槽的发动顺序未知，
 * 取均值即全排列的期望（与站点「所需综合力（期望）」同口径）。
 *
 * - 数字：所有技能槽统一按该倍率（倍率不是百分比，1 = +100%）；
 * - `'live'`：逐槽取**该槽成员卡的 live 技能**在**该卡技能等级**下的「无条件得分比率」
 *   （4★ L5 +130% 记 1.3；查 bundle.liveSkillRatios，缺数据回退 1.0）。
 *
 * 各方案的取值见 `baselineForScheme`（optimize.ts）：方案3（可自定义）默认统一 60%；方案0~2、4
 * 全量档 = 'live'、非全量档 = 50%。
 */
export type SkillBaseline = number | number[] | 'live';

/** 方案0 的统一技能基准：每槽 +60% */
export const SKILL_BASELINE_FLAT = 0.6;
/** 非全量档的技能基准：每槽 +50% */
export const SKILL_BASELINE_PRECISE = 0.5;

/** 该卡 live 技能的无条件得分比率（倍率；卡/技能/等级缺数据时回退 1.0 = +100%） */
export function liveSkillBaseline(bundle: MasterBundle, member: OwnedMember): number {
    const card = mcardById(bundle, member.cardId);
    const skillId = card ? Number(card[15] ?? 0) : 0;
    if (!skillId) return 1;
    const ratios = bundle.liveSkillRatios?.[String(skillId)];
    if (!ratios || !ratios.length) return 1;
    const level = Math.min(ratios.length, Math.max(1, Math.round(member.liveSkillLevel ?? 1)));
    const value = Number(ratios[level - 1]);
    return Number.isFinite(value) && value > 0 ? value / 10000 : 1;
}

/** 旧版 bundle（v3，无 live 技能数据）时 'live' 基准的说明（界面/notes 用） */
export const LIVE_DEGRADED_NOTE =
    '主数据是**旧版**（v3，无 live 技能数据）：全量档技能基准回退为各槽统一 +60%；网页平台更新后自动恢复。';

/** bundle 里有没有 live 技能数据（v4 起才有；v3 旧版没有 ⇒ 'live' 基准要回退） */
export function liveSkillsAvailable(bundle: MasterBundle): boolean {
    return !!bundle.liveSkillRatios && Object.keys(bundle.liveSkillRatios).length > 0;
}

/** 成员卡的持有角色 id（认不出卡时用 -cardId 兜底，避免把未知卡误判成同角色） */
export function memberCharacterId(bundle: MasterBundle, member: OwnedMember): number {
    const card = mcardById(bundle, member.cardId);
    return card ? card[4] : -member.cardId;
}

/**
 * 同一角色只能上一张角色卡（参考站组卡器的合法性检查 "duplicate-character: 此角色已在第 n 槽"）。
 * 组合枚举要过滤掉重复角色的队伍; 逐档替换（方案3）也要用它做合法性校验。
 */
export function hasDuplicateCharacter(bundle: MasterBundle, members: OwnedMember[]): boolean {
    const seen = new Set<number>();
    for (const member of members) {
        const id = memberCharacterId(bundle, member);
        if (seen.has(id)) return true;
        seen.add(id);
    }
    return false;
}

/** 一支队伍各技能槽的基准值（倍率数组，槽序与 members 一致） */
export function deckSkillBaseline(bundle: MasterBundle, members: OwnedMember[], baseline: SkillBaseline): number[] {
    if (typeof baseline === 'number') return members.map(() => baseline);
    if (Array.isArray(baseline)) {
        // 手填的逐槽值（方案0 的五项输入）；短的向后取最后一项/默认值
        const fallback = baseline[baseline.length - 1] ?? SKILL_BASELINE_FLAT;
        return members.map((_, i) => baseline[i] ?? fallback);
    }
    // 旧版 bundle（v3，无 live 技能数据）：回退统一 +60% 的保守基准，出说明见 skillBaselineNote
    if (!liveSkillsAvailable(bundle)) return members.map(() => SKILL_BASELINE_FLAT);
    return members.map(m => liveSkillBaseline(bundle, m));
}

/** 技能基准的均值（前 slots 个槽；发动顺序未知 → 期望口径 = 均值 × ΣW） */
export function skillMean(skills: number[], slots: number): number {
    const n = Math.min(slots, skills.length);
    if (n <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += skills[i] ?? 0;
    return sum / n;
}

/** 分/综合力（技能基准口径）：base + 基准均值 × ΣW */
export function baselineRate(chart: ChartEfficiency, skills: number[]): number {
    return chart.baseFree + skillMean(skills, chart.weightsFree.length) * chart.weightsFree.reduce((a, b) => a + b, 0);
}

/** 期望得分（技能基准口径，取整与 expectedScore 一致） */
export function expectedScoreBaseline(power: number, chart: ChartEfficiency, skills: number[]): number {
    return Math.floor(power * baselineRate(chart, skills));
}

/** 组卡搜索方案（网页组卡器可选；bot 固定方案0） */
export type DeckScheme = 0 | 1 | 2 | 3 | 4;

/**
 * 方案 → 技能基准：
 * - 方案0（现有算法）：各槽统一 +60%（不区分精度）；
 * - 方案1~4：全量档 = 各卡 live 技能（该卡技能等级的无条件得分比率）、非全量档 = 每槽 +50%。
 */
export function baselineForScheme(scheme: DeckScheme, precision: DeckPrecision, skillPercent?: number[]): SkillBaseline {
    if (scheme === 3) {
        // 方案3（基准取序·可自定义）的技能基准允许手填（参考站同款「五项手填值」）：默认五槽全 +60%
        if (skillPercent && skillPercent.length) {
            return skillPercent.map(v => (Number.isFinite(v) ? Math.min(1000, Math.max(0, v)) / 100 : SKILL_BASELINE_FLAT));
        }
        return SKILL_BASELINE_FLAT;
    }
    return precision === 'full' ? 'live' : SKILL_BASELINE_PRECISE;
}

/** 技能基准的说明文案（notes / 出图用） */
export function skillBaselineNote(scheme: DeckScheme, precision: DeckPrecision, skillPercent?: number[]): string {
    if (scheme === 3) {
        const values = skillPercent?.length ? skillPercent.map(v => Math.round(v)) : [60, 60, 60, 60, 60];
        return values.every(v => v === values[0])
            ? `技能基准：各槽统一 +${values[0]}%（手填值，未使用各卡实际技能）。`
            : `技能基准：各槽手填 ${values.join('/')}%（未使用各卡实际技能）。`;
    }
    return precision === 'full'
        ? '技能基准：各槽按该卡 live 技能在该卡技能等级下的无条件得分比率（全量档口径）。'
        : '技能基准：各槽统一 +50%（非全量档口径）。';
}


/** 期望得分 = 综合力 × (base + Σ 技能倍率 × 权重) */
export function expectedScore(power: number, chart: ChartEfficiency, skills: number[] = []): number {
    const weights = chart.weightsFree;
    const base = chart.baseFree;
    let rate = base;
    for (let i = 0; i < weights.length; i++) rate += (skills[i] ?? ASSUMED_SKILL_MULTIPLIER) * weights[i];
    return Math.floor(power * rate);
}

/** 得分落在哪个评级上（返回评级数字与分数线；一个都没到返回 null） */
export function scoreRank(chart: ChartEfficiency, score: number): [number, number] | null {
    let best: [number, number] | null = null;
    for (const entry of chart.ranks) {
        if (score >= entry[1] && (!best || entry[0] > best[0])) best = entry;
    }
    return best;
}

/** 每小时能打多少局 */
export function playsPerHour(chart: ChartEfficiency): number {
    if (!(chart.bgmMs > 0)) return 0;
    return 3600000 / (chart.bgmMs + OVERHEAD_MS);
}
