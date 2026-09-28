import { config } from '../config';
import { store } from '../data/masterdata';
import { logger } from '../logger';
import { Card } from '../types/Card';
import { SupportCard, Item } from '../types/SupportCard';
import { Gacha } from '../types/Gacha';

/**
 * 抽卡模拟(真实概率数据驱动)。
 *
 * 真实链路(已对 master 数据验证):
 *   MasterGacha.lotGroupId -> MasterGachaLot(行: 稀有度约束 + 资源类型约束 + 奖品组 + 权重)
 *   -> MasterGachaPrize(组内资源清单: resourceType + resourceId + UP 固定权重)
 * 抽一次 = 按权重选 lot 行 -> 组内按权重(UP 卡用 pickUpFixedRate, 否则 1)选资源。
 *
 * 兜底: 若某卡池无 lot 数据, 退回 GACHA_DEFAULT_RATES(配置的估计值) + 卡池内均匀权重。
 */

export type GachaDrawKind = 'member' | 'support' | 'item';

export interface GachaDrawResult {
    kind: GachaDrawKind;
    /** 稀有度: 2=R 3=SR 4=SSR; 道具为 0 */
    rarity: number;
    card?: Card;
    supportCard?: SupportCard;
    item?: Item;
    itemAmount?: number;
    /** 是否 UP 卡 */
    pickUp: boolean;
}

function pickWeighted<T>(entries: [T, number][]): T | undefined {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) return entries[0]?.[0];
    let r = Math.random() * total;
    for (const [value, w] of entries) {
        r -= w;
        if (r <= 0) return value;
    }
    return entries[entries.length - 1][0];
}

/** 真实数据抽取; 返回 undefined 表示该卡池无 lot 数据 */
async function drawFromLot(gacha: Gacha): Promise<GachaDrawResult | undefined> {
    const lotGroupId = gacha.row?.lotGroupId;
    if (!lotGroupId) return undefined;
    const lots = await store.gachaLotsByGroup(lotGroupId);
    if (lots.length === 0) return undefined;

    const lot = pickWeighted(lots.map(l => [l, l.weight] as [typeof l, number]));
    if (!lot) return undefined;
    const prizes = await store.gachaPrizesByGroup(lot.prizeGroupId);
    if (prizes.length === 0) return undefined;

    const prize = pickWeighted(prizes.map(p => [p, p.pickUpFixedRate > 0 ? p.pickUpFixedRate : 1] as [typeof p, number]));
    if (!prize) return undefined;
    const pickUp = prize.pickUpType === 2;

    if (prize.resourceType === 2) {
        const card = new Card(prize.resourceId);
        await card.init();
        if (!card.isExist) return undefined;
        return { kind: 'member', rarity: card.rarity || lot.rarityConstraint, card, pickUp };
    }
    if (prize.resourceType === 3) {
        const support = new SupportCard(prize.resourceId);
        await support.init();
        if (!support.isExist) return undefined;
        return { kind: 'support', rarity: support.rarity || lot.rarityConstraint, supportCard: support, pickUp };
    }
    // 道具
    const item = new Item(prize.resourceId);
    await item.init();
    if (!item.isExist) return undefined;
    return { kind: 'item', rarity: 0, item, itemAmount: prize.amount, pickUp };
}

/** 兜底抽取: 配置概率 + 全卡池均匀 */
async function drawFromFallback(): Promise<GachaDrawResult> {
    const rarityEntries = Object.entries(config.gachaDefaultRates)
        .map(([r, w]) => [parseInt(r, 10), w] as [number, number]);
    const rarity = pickWeighted(rarityEntries) ?? 2;
    const pool = (await store.cardList()).filter(c => c.rarity === rarity);
    const all = (await store.cardList());
    const candidates = pool.length > 0 ? pool : all;
    const picked = pickWeighted(candidates.map(c => [c, 1] as [typeof c, number]));
    if (!picked) throw new Error('card pool is empty');
    const card = new Card(picked.id);
    await card.init();
    return { kind: 'member', rarity, card, pickUp: false };
}

async function drawOnce(gacha: Gacha): Promise<GachaDrawResult> {
    try {
        const fromLot = await drawFromLot(gacha);
        if (fromLot) return fromLot;
    } catch (e) {
        logger('gacha', `lot-based draw failed, using fallback: ${e instanceof Error ? e.message : e}`);
    }
    return drawFromFallback();
}

/**
 * 抽卡 times 次(默认 10, 上限 10000)。
 * 10 连保底: 每第 10 抽若低于 SR, 提升为 SR(真实卡池数据下的模拟规则, 与游戏保底语义一致的近似)。
 */
export async function simulateGacha(gacha: Gacha, times: number): Promise<GachaDrawResult[]> {
    const results: GachaDrawResult[] = [];
    for (let i = 0; i < times; i++) {
        let result = await drawOnce(gacha);
        if (i % 10 === 9 && (result.kind === 'item' || result.rarity < 3)) {
            const upgraded = await drawUpgraded(gacha);
            if (upgraded) result = upgraded;
        }
        results.push(result);
    }
    return results;
}

/** 保底: 抽一张 SR 及以上成员卡 */
async function drawUpgraded(gacha: Gacha): Promise<GachaDrawResult | undefined> {
    const lotGroupId = gacha.row?.lotGroupId;
    if (lotGroupId) {
        const lots = (await store.gachaLotsByGroup(lotGroupId))
            .filter(l => l.rarityConstraint >= 3);
        if (lots.length > 0) {
            const lot = pickWeighted(lots.map(l => [l, l.weight] as [typeof l, number]));
            if (lot) {
                const prizes = (await store.gachaPrizesByGroup(lot.prizeGroupId))
                    .filter(p => p.resourceType === 2 || p.resourceType === 3);
                const prize = pickWeighted(prizes.map(p => [p, p.pickUpFixedRate > 0 ? p.pickUpFixedRate : 1] as [typeof p, number]));
                if (prize) {
                    if (prize.resourceType === 2) {
                        const card = new Card(prize.resourceId);
                        await card.init();
                        if (card.isExist) return { kind: 'member', rarity: card.rarity || lot.rarityConstraint, card, pickUp: prize.pickUpType === 2 };
                    } else {
                        const support = new SupportCard(prize.resourceId);
                        await support.init();
                        if (support.isExist) return { kind: 'support', rarity: support.rarity || lot.rarityConstraint, supportCard: support, pickUp: prize.pickUpType === 2 };
                    }
                }
            }
        }
    }
    // 兜底: 从 SSR/SR 卡池中选
    const pool = (await store.cardList()).filter(c => c.rarity >= 3);
    const picked = pickWeighted(pool.map(c => [c, 1] as [typeof c, number]));
    if (!picked) return undefined;
    const card = new Card(picked.id);
    await card.init();
    return { kind: 'member', rarity: card.rarity, card, pickUp: false };
}

/** 找当前开放的卡池(优先非限定) */
export async function getCurrentGacha(): Promise<Gacha | undefined> {
    const rows = await store.gachaList();
    const now = new Date();
    const open: Gacha[] = [];
    for (const row of rows) {
        const g = new Gacha(row.id);
        await g.init();
        if (g.isOpen(now)) open.push(g);
    }
    open.sort((a, b) => (a.isLimited ? 1 : 0) - (b.isLimited ? 1 : 0));
    return open[0];
}

/** 卡池真实概率汇总(按稀有度), 供展示/测试 */
export async function getGachaRates(gacha: Gacha): Promise<Record<string, number> | undefined> {
    const lotGroupId = gacha.row?.lotGroupId;
    if (!lotGroupId) return undefined;
    const lots = await store.gachaLotsByGroup(lotGroupId);
    if (lots.length === 0) return undefined;
    const total = lots.reduce((sum, l) => sum + l.weight, 0);
    const byRarity: Record<string, number> = {};
    for (const lot of lots) {
        const key = lot.rarityConstraint === 0 ? 'item' : String(lot.rarityConstraint);
        byRarity[key] = (byRarity[key] ?? 0) + lot.weight;
    }
    for (const key of Object.keys(byRarity)) {
        byRarity[key] = Math.round((byRarity[key] / total) * 10000) / 100; // 百分比, 2 位小数
    }
    return byRarity;
}
