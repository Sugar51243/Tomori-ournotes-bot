import { deckPower, hasDuplicateCharacter, memberPower, supportRates } from './deck';
import type { DeckPower, OwnedMember, OwnedSupport } from './deck';
import type { GameAccountCardsData, GameAccountItemsData, MasterBundle } from './types';

/**
 * 各乐队的**理论最高综合力队伍**（bot 的查玩家图用；网页那边没有这个口径，是本次新增）。
 *
 * 口径（与网页组卡器的「最高综合力队伍」同源，只把成员卡池限定到该乐队）：
 * - 成员：该乐队角色的成员卡里穷举选 5（`precision:'full'` 且**不带歌** ——
 *   类型加成/偏好曲两个跟歌走的组件自动为 0，保留队长技能/类型链接/T.G.W）；
 * - 留影：全账号的候选组合里取最优（留影不绑定乐队，与网页 optimize 一致）；
 * - 乐队道具：该乐队道具的当前等级（`bandItemRates` 按乐队/角色匹配，正好各吃各的）。
 *
 * 搜索是"先穷举再精修"：成员组合按默认留影组合全量评估，前 8 名再对 8 组留影候选 × 5 个队长槽位精修。
 * 与网页的启发式同风格——**不保证全局最优**，出图不承诺"理论"以外的口径（页脚注明）。
 */

/** 单个乐队的候选池上限（排序后截取最强的一批，控制组合数：C(20,5)=15504） */
const MEMBER_POOL_PER_BAND = 20;
/** 精修的成员组合数 */
const REFINE_COMBOS = 8;
/** 留影候选：按支援率排序后取前 12，生成前 8 组(5 张)组合 + 纯 top5 一组 */
const SUPPORT_POOL = 12;
const SUPPORT_COMBOS = 8;

export interface BandDeck {
    bandId: number;
    bandNameIdx: number;
    power: DeckPower;
    members: OwnedMember[];
    supports: OwnedSupport[];
}

/** 生成 size=5 的组合下标 */
function* combos(n: number, k: number): Generator<number[]> {
    const idx = Array.from({ length: k }, (_, i) => i);
    while (true) {
        yield idx.slice();
        let i = k - 1;
        while (i >= 0 && idx[i] === n - k + i) i--;
        if (i < 0) return;
        idx[i]++;
        for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
}

/** 把 import 记录形态的卡片/道具摊成算卡力需要的结构 */
export function toOwnedCards(cards: GameAccountCardsData): { members: OwnedMember[]; supports: OwnedSupport[]; characterRanks: Map<number, number> } {
    return {
        members: (cards.members ?? []).map(([cardId, level, training, awakening]) => ({ cardId, level, training, awakening })),
        supports: (cards.supports ?? []).map(([cardId, level, limitBreak]) => ({ cardId, level, limitBreak })),
        characterRanks: new Map((cards.characters ?? []) as Array<[number, number]>)
    };
}

export function toBandItemLevels(items: GameAccountItemsData): Map<number, number> {
    return new Map((items.bandItems ?? []) as Array<[number, number]>);
}

/** 留影候选组合：按支援率(三项合计)排序取池 → 前 8 组 + 纯 top5 */
function supportCombos(supports: OwnedSupport[], bundle: MasterBundle): OwnedSupport[][] {
    const ranked = supports
        .map(s => ({ s, v: supportRates(bundle, s).reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.v - a.v)
        .slice(0, SUPPORT_POOL)
        .map(x => x.s);
    if (ranked.length <= 5) return [ranked];

    const out: OwnedSupport[][] = [];
    for (const pick of combos(ranked.length, 5)) {
        out.push(pick.map(i => ranked[i]));
        if (out.length >= SUPPORT_COMBOS) break;
    }
    const top5 = ranked.slice(0, 5);
    if (!out.some(c => c.every((s, i) => s.cardId === top5[i]?.cardId))) out.push(top5);
    return out;
}

/**
 * 算各乐队的理论最高综合力队伍。
 * @returns 按 bandId 升序；成员不足 5 张的乐队不出现在结果里
 */
export function bestDecksPerBand(
    bundle: MasterBundle,
    cards: GameAccountCardsData,
    items: GameAccountItemsData,
    tgwCardRank?: number,
    maxBands = 12
): BandDeck[] {
    const { members, supports, characterRanks } = toOwnedCards(cards);
    const bandItemLevels = toBandItemLevels(items);
    if (members.length < 5) return [];

    // 卡 → 角色 → 乐队
    const mcardById = new Map(bundle.mcards.map(c => [c[0], c]));
    const bandOfCharacter = new Map(bundle.chars.map(c => [c[0], c[2]]));
    const byBand = new Map<number, OwnedMember[]>();
    for (const m of members) {
        const card = mcardById.get(m.cardId);
        if (!card) continue;
        const bandId = bandOfCharacter.get(card[4]);
        if (bandId === undefined) continue;
        const list = byBand.get(bandId) ?? [];
        list.push(m);
        byBand.set(bandId, list);
    }

    const sCombos = supportCombos(supports, bundle);
    const bands = [...byBand.entries()].sort((a, b) => a[0] - b[0]).slice(0, maxBands);
    const out: BandDeck[] = [];

    for (const [bandId, pool] of bands) {
        if (pool.length < 5) continue;
        const bandNameIdx = bundle.bands.find(b => b[0] === bandId)?.[1] ?? 0;
        const base = { characterRanks, bandItemLevels, tgwCardRank, precision: 'full' as const };

        // 先按"最强留影"全量评估所有成员组合; 候选池超限时按**卡自身卡力**截池
        // (与网页 optimize 的 memberValue 排序同思路, 只为控制组合数)
        const candidates = pool.length > MEMBER_POOL_PER_BAND
            ? [...pool]
                .map(m => ({ m, v: memberPower(bundle, m)?.total ?? 0 }))
                .sort((a, b) => b.v - a.v)
                .slice(0, MEMBER_POOL_PER_BAND)
                .map(x => x.m)
            : pool;

        const scored: Array<{ members: OwnedMember[]; supports: OwnedSupport[]; power: DeckPower }> = [];
        const defaultSupports = sCombos[0];
        for (const pick of combos(candidates.length, 5)) {
            const picked = pick.map(i => candidates[i]);
            // 同一角色只能上一张角色卡（参考站组卡器的 legality）
            if (hasDuplicateCharacter(bundle, picked)) continue;
            const power = deckPower(bundle, { ...base, members: picked, supports: defaultSupports });
            scored.push({ members: picked, supports: defaultSupports, power });
        }
        scored.sort((a, b) => b.power.total - a.power.total);

        // 精修: 前 8 个成员组合 × 全部留影候选 × 5 个队长槽位
        let best = scored[0];
        for (const cand of scored.slice(0, REFINE_COMBOS)) {
            for (const sup of sCombos) {
                for (let leader = 0; leader < 5; leader++) {
                    const order = [...cand.members];
                    const [moved] = order.splice(leader, 1);
                    order.unshift(moved);
                    const power = deckPower(bundle, { ...base, members: order, supports: sup });
                    if (power.total > best.power.total) best = { members: order, supports: sup, power };
                }
            }
        }
        out.push({ bandId, bandNameIdx, power: best.power, members: best.members, supports: best.supports });
    }
    return out;
}
