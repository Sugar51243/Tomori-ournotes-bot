import { clientFor } from './client';
import { createTextResolver, TextResolver } from './text';
import { resetSkillCache } from '../skills';
import { Server } from '../../types/Server';
import {
    LiveMusicRow, LiveMusicScoreRow, BandRow, CharacterRow,
    MemberCardRow, GachaRow, EventRow, GachaLotRow, GachaPrizeRow,
    SupportCardRow, ItemRow, MusicCategoryRow, PenLightColorRow, StampRow,
    EventEffectRow, EventPickupCardRow, ChallengeMusicRow,
    LiveEventPointRow, LiveEventRewardRow, LiveScoreRankRow,
    EventAchievementRewardRow, RewardRow, ChallengeLiveEventPointRow,
    ChallengeLiveEventRewardRow
} from '../../types/MasterData';
import { logger } from '../../logger';

/**
 * 实体关联的倒排索引。
 *
 * 只放 **id 与原始时间字符串** —— 时间解析要用 `parseGameDate`(`types/Gacha.ts`),
 * 而那个模块反过来依赖 `data/region.ts`, 在本文件里 import 会形成环。
 * 解析与命名统一放在 `src/data/relations.ts`。
 *
 * 「活动 ↔ 卡池」上游没有直接字段, 靠 `upCardKeysByGacha` 与 `cardKeysByEvent` 求交集推断
 * (规则见 `relations.ts` 的 `eventGachaRelated`)。卡片键形如 `m:61`(成员卡) / `s:62`(支援卡),
 * 两者 id 空间重叠, 必须带前缀。
 */
export interface RelatedIndex {
    /** 卡片键 -> 该卡作为 UP 卡出现的卡池 id */
    gachaIdsByCard: Map<string, number[]>;
    /** gachaId -> 该卡池的 UP 卡键集合 */
    upCardKeysByGacha: Map<number, Set<string>>;
    /** musicId -> 活动 id(MasterEvent.musicId ∪ MasterChallengeMusic.liveMusicId) */
    eventIdsByMusic: Map<number, number[]>;
    /** 卡片键 -> 活动 id(活动卡 ∪ 加成对象卡) */
    eventIdsByCard: Map<string, number[]>;
    /** eventId -> 活动卡键集合 */
    cardKeysByEvent: Map<number, Set<string>>;
    /** eventId -> 原始时间串(startAt / displayEndAt), 解析见 relations.ts */
    eventTimes: Map<number, { startAt: string; endAt: string }>;
    /** gachaId -> 原始时间串(startAt / endAt) */
    gachaTimes: Map<number, { startAt: string; endAt: string }>;
}

/**
 * MasterDataStore 门面(每个区域一个实例): 各类表懒加载 + 常用查找。
 * dataVersion 变化时由 refresh() 重置文本缓存与各表引用(懒加载重新拉取)。
 */
export class MasterDataStore {
    readonly server: Server;
    readonly text: TextResolver;

    private liveMusic: LiveMusicRow[] | undefined;
    private liveMusicScore: LiveMusicScoreRow[] | undefined;
    private bands: BandRow[] | undefined;
    private characterRows: CharacterRow[] | undefined;
    private cards: MemberCardRow[] | undefined;
    private gachas: GachaRow[] | undefined;
    private events: EventRow[] | undefined;
    private gachaLots: GachaLotRow[] | undefined;
    private gachaPrizes: GachaPrizeRow[] | undefined;
    private supportCards: SupportCardRow[] | undefined;
    private items: ItemRow[] | undefined;
    private stamps: StampRow[] | undefined;
    private related: RelatedIndex | undefined;
    private relatedInflight: Promise<RelatedIndex> | undefined;

    constructor(server: Server) {
        this.server = server;
        this.text = createTextResolver(server);
    }

    async refresh(): Promise<void> {
        const changed = await clientFor(this.server).refreshIfVersionChanged();
        if (changed) {
            this.liveMusic = this.liveMusicScore = this.bands = this.characterRows = this.cards = undefined;
            this.gachas = this.events = this.gachaLots = this.gachaPrizes = this.supportCards = this.items = this.stamps = undefined;
            // 关联倒排索引建立在上面这些表之上, 必须一并失效, 否则版本切换后会用旧行算关联
            this.related = undefined;
            this.relatedInflight = undefined;
            this.text.reset();
            resetSkillCache(this.server);
            logger('masterdata', `[${this.server}] store reset, tables will be lazily reloaded`);
        }
    }

    async songs(): Promise<LiveMusicRow[]> {
        this.liveMusic ??= await clientFor(this.server).getTable<LiveMusicRow>('MasterLiveMusic');
        return this.liveMusic;
    }

    async songById(id: number): Promise<LiveMusicRow | undefined> {
        return (await this.songs()).find(s => s.id === id);
    }

    async songScores(): Promise<LiveMusicScoreRow[]> {
        this.liveMusicScore ??= await clientFor(this.server).getTable<LiveMusicScoreRow>('MasterLiveMusicScore');
        return this.liveMusicScore;
    }

    /** musicId*100 + difficultyId(0-3) -> 分数行 */
    async scoreByChartId(chartId: number): Promise<LiveMusicScoreRow | undefined> {
        return (await this.songScores()).find(s => s.id === chartId);
    }

    async bandList(): Promise<BandRow[]> {
        this.bands ??= await clientFor(this.server).getTable<BandRow>('MasterBand');
        return this.bands;
    }

    async bandById(id: number): Promise<BandRow | undefined> {
        return (await this.bandList()).find(b => b.id === id);
    }

    async characters(): Promise<CharacterRow[]> {
        this.characterRows ??= await clientFor(this.server).getTable<CharacterRow>('MasterCharacter');
        return this.characterRows;
    }

    async characterById(id: number): Promise<CharacterRow | undefined> {
        return (await this.characters()).find(c => c.id === id);
    }

    async cardList(): Promise<MemberCardRow[]> {
        this.cards ??= await clientFor(this.server).getTable<MemberCardRow>('MasterMemberCard');
        return this.cards;
    }

    async cardById(id: number): Promise<MemberCardRow | undefined> {
        return (await this.cardList()).find(c => c.id === id);
    }

    async gachaList(): Promise<GachaRow[]> {
        this.gachas ??= await clientFor(this.server).getTable<GachaRow>('MasterGacha');
        return this.gachas;
    }

    async gachaById(id: number): Promise<GachaRow | undefined> {
        return (await this.gachaList()).find(g => g.id === id);
    }

    async eventList(): Promise<EventRow[]> {
        this.events ??= await clientFor(this.server).getTable<EventRow>('MasterEvent');
        return this.events;
    }

    async eventById(id: number): Promise<EventRow | undefined> {
        return (await this.eventList()).find(e => e.id === id);
    }

    /** 卡池抽奖组(真实概率数据) */
    async gachaLotList(): Promise<GachaLotRow[]> {
        this.gachaLots ??= await clientFor(this.server).getTable<GachaLotRow>('MasterGachaLot');
        return this.gachaLots;
    }

    async gachaLotsByGroup(lotGroupId: number): Promise<GachaLotRow[]> {
        return (await this.gachaLotList()).filter(l => l.lotGroupId === lotGroupId);
    }

    /** 卡池奖品(组内资源清单) */
    async gachaPrizeList(): Promise<GachaPrizeRow[]> {
        this.gachaPrizes ??= await clientFor(this.server).getTable<GachaPrizeRow>('MasterGachaPrize');
        return this.gachaPrizes;
    }

    async gachaPrizesByGroup(groupId: number): Promise<GachaPrizeRow[]> {
        return (await this.gachaPrizeList()).filter(p => p.groupId === groupId);
    }

    async supportCardList(): Promise<SupportCardRow[]> {
        this.supportCards ??= await clientFor(this.server).getTable<SupportCardRow>('MasterSupportCard');
        return this.supportCards;
    }

    async supportCardById(id: number): Promise<SupportCardRow | undefined> {
        return (await this.supportCardList()).find(c => c.id === id);
    }

    async itemList(): Promise<ItemRow[]> {
        this.items ??= await clientFor(this.server).getTable<ItemRow>('MasterItem');
        return this.items;
    }

    async itemById(id: number): Promise<ItemRow | undefined> {
        return (await this.itemList()).find(i => i.id === id);
    }

    async stampList(): Promise<StampRow[]> {
        this.stamps ??= await clientFor(this.server).getTable<StampRow>('MasterStamp');
        return this.stamps;
    }

    async stampById(id: number): Promise<StampRow | undefined> {
        return (await this.stampList()).find(s => s.id === id);
    }

    /** 道具名称(战斗道具/招募券等) */
    async itemName(id: number): Promise<string> {
        if (!id) return '';
        const row = await this.itemById(id);
        return row ? await this.text.t(row.nameTextId) : '';
    }

    /** 音乐分类名称(按分类 id 列表, 取其中一条分类行的本地化文本) */
    async musicCategoryNames(categoryIds: number[]): Promise<string[]> {
        if (!categoryIds?.length) return [];
        const rows = await clientFor(this.server).getTable<MusicCategoryRow>('MasterLiveMusicCategory').catch(() => []);
        const names: string[] = [];
        for (const id of categoryIds) {
            const row = rows.find(r => (r.musicCategories ?? []).includes(id));
            if (!row) continue;
            const name = await this.text.t(row.textKey);
            if (name && name !== row.textKey) names.push(name);
        }
        return names;
    }

    // ---- 活动相关 ----
    // 注: 早期实测 MasterEvent 只有 jp 有数据, 现在四区域都已上线活动(活动数据各服独立上传)

    async eventEffectsByEvent(eventId: number): Promise<EventEffectRow[]> {
        const rows = await clientFor(this.server).getTable<EventEffectRow>('MasterEventEffect').catch(() => []);
        return rows.filter(r => Number(r.eventId) === eventId);
    }

    async eventPickupCardsByEvent(eventId: number): Promise<EventPickupCardRow[]> {
        const rows = await clientFor(this.server).getTable<EventPickupCardRow>('MasterEventPickupCard').catch(() => []);
        return rows.filter(r => Number(r.eventId) === eventId);
    }

    async challengeMusicByEvent(eventId: number): Promise<ChallengeMusicRow[]> {
        const rows = await clientFor(this.server).getTable<ChallengeMusicRow>('MasterChallengeMusic').catch(() => []);
        return rows.filter(r => Number(r.eventId) === eventId);
    }

    async liveEventPointsByGroup(group: number): Promise<LiveEventPointRow[]> {
        if (!group) return [];
        const rows = await clientFor(this.server).getTable<LiveEventPointRow>('MasterLiveEventPoint').catch(() => []);
        return rows.filter(r => Number(r.group) === group);
    }

    async liveEventRewardsByGroup(eventGroup: number): Promise<LiveEventRewardRow[]> {
        if (!eventGroup) return [];
        const rows = await clientFor(this.server).getTable<LiveEventRewardRow>('MasterLiveEventReward').catch(() => []);
        return rows.filter(r => Number(r.eventGroup) === eventGroup);
    }

    async liveScoreRanksByGroup(group: number): Promise<LiveScoreRankRow[]> {
        if (!group) return [];
        const rows = await clientFor(this.server).getTable<LiveScoreRankRow>('MasterLiveScoreRank').catch(() => []);
        return rows.filter(r => Number(r.group) === group);
    }

    /** 累计点数奖励(里程碑): 达到指定活动点数给 rewardIds 里的东西 */
    async achievementRewardsByEvent(eventId: number): Promise<EventAchievementRewardRow[]> {
        const rows = await clientFor(this.server).getTable<EventAchievementRewardRow>('MasterEventAchievementReward').catch(() => []);
        return rows.filter(r => Number(r.eventId) === eventId).sort((a, b) => a.eventPoint - b.eventPoint);
    }

    /** 奖励条目(MasterReward): 按 id 批量取 */
    async rewardsByIds(ids: number[]): Promise<Map<number, RewardRow>> {
        if (!ids.length) return new Map();
        const rows = await clientFor(this.server).getTable<RewardRow>('MasterReward').catch(() => []);
        const want = new Set(ids);
        return new Map(rows.filter(r => want.has(r.id)).map(r => [r.id, r]));
    }

    /** 挑战演出点数(MasterChallengeLiveEventPoint) */
    async challengeLiveEventPointsByGroup(group: number): Promise<ChallengeLiveEventPointRow[]> {
        if (!group) return [];
        const rows = await clientFor(this.server).getTable<ChallengeLiveEventPointRow>('MasterChallengeLiveEventPoint').catch(() => []);
        return rows.filter(r => Number(r.group) === group);
    }

    /** 挑战演出报酬(MasterChallengeLiveEventReward) */
    async challengeLiveEventRewardsByGroup(eventGroup: number): Promise<ChallengeLiveEventRewardRow[]> {
        if (!eventGroup) return [];
        const rows = await clientFor(this.server).getTable<ChallengeLiveEventRewardRow>('MasterChallengeLiveEventReward').catch(() => []);
        return rows.filter(r => Number(r.eventGroup) === eventGroup);
    }

    // ---- 实体关联(相关卡池 / 相关活动) ----

    /** 关联倒排索引(懒构建 + 单飞); 构建失败不缓存, 下次请求重试 */
    async relatedIndex(): Promise<RelatedIndex> {
        if (this.related) return this.related;
        if (!this.relatedInflight) {
            this.relatedInflight = this.buildRelatedIndex().catch(e => {
                this.relatedInflight = undefined;
                throw e;
            });
        }
        const built = await this.relatedInflight;
        this.related = built;
        this.relatedInflight = undefined;
        return built;
    }

    private async buildRelatedIndex(): Promise<RelatedIndex> {
        const client = clientFor(this.server);
        // 表缺失一律退化为空表(与 eventEffectsByEvent 同款容错)
        const optional = <T>(name: string): Promise<T[]> => client.getTable<T>(name).catch(() => []);

        const [gachas, lots, prizes, events, effects, pickUps, challengeMusic] = await Promise.all([
            this.gachaList().catch(() => [] as GachaRow[]),
            this.gachaLotList().catch(() => [] as GachaLotRow[]),
            this.gachaPrizeList().catch(() => [] as GachaPrizeRow[]),
            this.eventList().catch(() => [] as EventRow[]),
            optional<EventEffectRow>('MasterEventEffect'),
            optional<EventPickupCardRow>('MasterEventPickUpCard'),
            optional<ChallengeMusicRow>('MasterChallengeMusic')
        ]);

        const index: RelatedIndex = {
            gachaIdsByCard: new Map(),
            upCardKeysByGacha: new Map(),
            eventIdsByMusic: new Map(),
            eventIdsByCard: new Map(),
            cardKeysByEvent: new Map(),
            eventTimes: new Map(),
            gachaTimes: new Map()
        };
        // 卡片键: resourceType 2=成员卡 3=支援卡(两者 id 空间重叠, 必须带前缀)
        const keyOf = (resourceType: number, resourceId: number): string | undefined => {
            if (!resourceId) return undefined;
            if (resourceType === 2) return `m:${resourceId}`;
            if (resourceType === 3) return `s:${resourceId}`;
            return undefined;
        };
        const add = <T>(map: Map<number, T[]>, key: number, value: T): void => {
            const list = map.get(key);
            if (list) {
                if (!list.includes(value)) list.push(value);
            } else {
                map.set(key, [value]);
            }
        };
        /** 活动卡与加成对象卡都走这里登记(两个方向各写一次, 供活动↔卡池求交集与卡片反查) */
        const addEventCard = (eventId: number, key: string): void => {
            let set = index.cardKeysByEvent.get(eventId);
            if (!set) index.cardKeysByEvent.set(eventId, (set = new Set()));
            set.add(key);
            const list = index.eventIdsByCard.get(key);
            if (list) {
                if (!list.includes(eventId)) list.push(eventId);
            } else {
                index.eventIdsByCard.set(key, [eventId]);
            }
        };

        // ---- 卡池: MasterGacha -> MasterGachaLot -> MasterGachaPrize(pickUpType=2) ----
        const prizesByGroup = new Map<number, GachaPrizeRow[]>();
        for (const prize of prizes) {
            const list = prizesByGroup.get(prize.groupId);
            if (list) list.push(prize);
            else prizesByGroup.set(prize.groupId, [prize]);
        }
        const lotsByGroup = new Map<number, GachaLotRow[]>();
        for (const lot of lots) {
            const list = lotsByGroup.get(lot.lotGroupId);
            if (list) list.push(lot);
            else lotsByGroup.set(lot.lotGroupId, [lot]);
        }
        for (const gacha of gachas) {
            index.gachaTimes.set(gacha.id, {
                startAt: String(gacha.startAt ?? ''),
                endAt: String(gacha.endAt ?? '')
            });
            const up = new Set<string>();
            for (const lot of lotsByGroup.get(gacha.lotGroupId) ?? []) {
                for (const prize of prizesByGroup.get(lot.prizeGroupId) ?? []) {
                    if (prize.pickUpType !== 2) continue;
                    const key = keyOf(prize.resourceType, prize.resourceId);
                    if (key) up.add(key);
                }
            }
            if (up.size === 0) continue;
            index.upCardKeysByGacha.set(gacha.id, up);
            for (const key of up) {
                const list = index.gachaIdsByCard.get(key);
                if (list) {
                    if (!list.includes(gacha.id)) list.push(gacha.id);
                } else {
                    index.gachaIdsByCard.set(key, [gacha.id]);
                }
            }
        }

        // ---- 活动: 时间 + 主曲 + 活动卡 + 加成对象卡 ----
        for (const event of events) {
            index.eventTimes.set(event.id, {
                startAt: String(event.startAt ?? ''),
                // 展示结束时间比 endAt 晚, 与活动页显示的口径一致
                endAt: String(event.displayEndAt ?? event.endAt ?? '')
            });
            if (event.musicId) add(index.eventIdsByMusic, event.musicId, event.id);
        }
        for (const row of pickUps) {
            const eventId = Number(row.eventId);
            const key = keyOf(row.resourceType, row.resourceId);
            if (eventId && key) addEventCard(eventId, key);
        }
        for (const row of effects) {
            const eventId = Number(row.eventId);
            if (!eventId) continue;
            const key = keyOf(2, row.memberCardId) ?? keyOf(3, row.supportCardId);
            if (key) addEventCard(eventId, key);
        }
        // 挑战演出曲(一个活动可有多首)
        for (const row of challengeMusic) {
            const eventId = Number(row.eventId);
            const musicId = Number(row.liveMusicId);
            if (eventId && musicId) add(index.eventIdsByMusic, musicId, eventId);
        }

        logger('masterdata', `[${this.server}] related index built: `
            + `${index.gachaIdsByCard.size} card→gacha, ${index.eventIdsByCard.size} card→event, `
            + `${index.eventIdsByMusic.size} song→event, ${index.upCardKeysByGacha.size} gacha UP sets`);
        return index;
    }

    /** 应援色(主色 + 副色, 十六进制) */
    async penLightColors(colorId: number): Promise<string[]> {
        if (!colorId) return [];
        const rows = await clientFor(this.server).getTable<PenLightColorRow>('MasterLiveMusicPenLightColor').catch(() => []);
        const row = rows.find(r => r.id === colorId);
        if (!row) return [];
        return [row.mainColor, row.sub1Color, row.sub2Color, row.sub3Color, row.sub4Color]
            .filter((c): c is string => !!c && /^#[0-9A-Fa-f]{6}$/.test(c));
    }
}
