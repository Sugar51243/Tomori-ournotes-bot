import { EventRow, EventEffectRow, EventPickupCardRow, ChallengeMusicRow } from './MasterData';
import { regionFor } from '../data/region';
import { parseGameDate } from './Gacha';
import { eventBackgroundUrl, eventLogoUrl } from '../data/assets';
import { attributeName } from './Card';
import { Server, defaultServer } from './Server';

type TextFn = (id: string, locale?: string) => Promise<string>;
type Store = ReturnType<typeof regionFor>["store"];

/** 活动里引到的一张卡(成员卡或留影) */
export interface EventCardRef {
    kind: 'member' | 'support';
    cardId: number;
    name: string;
    /** 素材编号(成员卡即 cardId, 留影用 assetID) */
    assetId: number;
}

/** 活动加成里的具体卡片: 带 rank1..5 的加成百分比 */
export interface EventBonusCard extends EventCardRef {
    /** 5 个觉醒等级的加成(百分数, 已从万分位换算) */
    bonusByRank: number[];
}

/**
 * 加成条件(按乐队/属性)。
 * 同一个条件常常同时有成员与支援两行且数值不同, 这里按条件名合并:
 * `member` / `support` 各存一侧的加成, 展示时用一行 + 两列, 不重复列条件。
 */
export interface EventBonusCondition {
    /** 如「梦限大MewType」「绀碧属性」 */
    label: string;
    /** 成员加成(百分数); 没有该侧时为 undefined */
    member?: number;
    /** 支援加成(百分数) */
    support?: number;
}

export interface EventSong {
    musicId: number;
    title: string;
    jacketAssetName: string;
}

/** 奖励条目(道具 / 角色卡 / 支援卡) */
export interface EventRewardItem {
    kind: 'item' | 'member' | 'support';
    id: number;
    name: string;
    /** 道具图标的 imagePath(卡片为空) */
    imagePath: string;
    count: number;
}

/** 累计点数奖励的一档: 达到 pt 给这些奖励 */
export interface EventPointMilestone {
    point: number;
    rewards: EventRewardItem[];
}

/** 演出报酬的一行: 得分评级 -> 活动点数 + 道具 */
export interface EventLiveRewardRow {
    scoreRank: number;
    /** 该评级每场演出拿到的活动点数(来自 MasterLiveEventPoint) */
    points: number;
    /** 该评级对应的分数门槛(可能缺省) */
    requiredScore?: number;
    items: EventRewardItem[];
}

export type EventStatus = 'upcoming' | 'open' | 'ended';

/**
 * 活动模型。
 * 与其它领域模型一致: 构造函数只收 id, 区域是构造后的字段(默认主服)。
 *
 * 主数据里**没有「活动种类名称」表**, 所以「种类」用活动自身的排名开关拼出来
 * (实测该活动 = 乐曲排名 · 乐曲总排名), 见 typeLabel()。
 */
export class Event {
    eventId: number;
    /** 该实体由哪个区域渲染(文本/素材来源) */
    server: Server = defaultServer();
    isExist = false;
    row?: EventRow;
    eventName = '';
    startAt?: Date;
    endAt?: Date;
    /** 展示用结束时间(结算展示, 通常晚于 endAt) */
    displayEndAt?: Date;
    eventType = 0;
    logoAsset = '';

    itemId = 0;
    itemName = '';
    itemImagePath = '';

    songs: EventSong[] = [];
    bonusCards: EventBonusCard[] = [];
    bonusConditions: EventBonusCondition[] = [];
    eventCards: EventCardRef[] = [];
    /**
     * 达到指定活动点数可拿的奖励。
     * **只保留含星钻/幸运水晶/奇迹水晶/棱晶/角色卡/支援卡的档位** —— 全量 78 档里大半是金币与经验,
     * 全画出来图会非常长。被筛掉的档位仍然计入 totalRewards。
     */
    pointMilestones: EventPointMilestone[] = [];
    /** **全部**累计点数奖励的合计(不做筛选, 含金币/经验/技能券等) */
    totalRewards: EventRewardItem[] = [];
    /** 演出报酬(得分评级 + 活动点数 + 道具) */
    liveRewards: EventLiveRewardRow[] = [];
    /** 挑战演出报酬(同结构, 数据来自 MasterChallengeLive* 两张表) */
    challengeRewards: EventLiveRewardRow[] = [];

    /** 模糊搜索维度: 本活动涉及到的乐队 / 角色 / 卡片属性 */
    bonusBandIds: number[] = [];
    bonusCharacterIds: number[] = [];
    bonusCardTypes: number[] = [];
    /**
     * 乐队/角色的**名称**文本。
     * 关键词只写了名字的一部分(如「千石」)时 fuzzySearch 不会命中索引别名, 会落到 `_all` 子串回退,
     * 而回退只认目标对象里的字符串字段 —— 所以名称必须一并暴露出来。
     */
    bonusBandNames: string[] = [];
    bonusCharacterNames: string[] = [];

    constructor(eventId: number) {
        this.eventId = eventId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.eventById(this.eventId);
        if (!this.row) return;
        this.isExist = true;

        const r = this.row;
        const nameId = String(r.nameTextId ?? r.eventNameTextId ?? '');
        this.eventName = nameId ? await t(nameId) : `Event ${this.eventId}`;
        this.startAt = parseGameDate(String(r.startAt ?? ''), this.server);
        this.endAt = parseGameDate(String(r.endAt ?? ''), this.server);
        this.displayEndAt = parseGameDate(String(r.displayEndAt ?? ''), this.server);
        this.eventType = r.eventType ?? 0;
        this.logoAsset = String(r.logoAsset ?? '');

        await this.loadItem(store, t);
        await this.loadSongs(store, t);
        await this.loadBonus(store, t);
        await this.loadEventCards(store, t);
        await this.loadRewards(store, t);
    }

    // ---- 各段数据: 缺表/缺数据一律静默跳过, 不影响活动本体 ----

    private async loadItem(store: Store, t: TextFn): Promise<void> {
        if (!this.row?.eventItemId) return;
        const item = await store.itemById(this.row.eventItemId);
        if (!item) return;
        this.itemId = item.id;
        this.itemName = await t(item.nameTextId);
        this.itemImagePath = item.imagePath;
    }

    /**
     * 活动歌曲: **只列本次活动的新曲**(即 MasterEvent.musicId)。
     * MasterChallengeMusic 里的另几首是挑战曲, 复用的是已有的老歌, 不算活动新曲, 故不列。
     */
    private async loadSongs(store: Store, t: TextFn): Promise<void> {
        const musicId = this.row?.musicId;
        if (!musicId) return;
        const music = await store.songById(musicId);
        if (!music) return;
        this.songs.push({ musicId, title: await t(music.titleTextID), jacketAssetName: music.jacketAssetName });
    }

    private async loadBonus(store: Store, t: TextFn): Promise<void> {
        const rows: EventEffectRow[] = await store.eventEffectsByEvent(this.eventId);
        const bands = new Set<number>();
        const characters = new Set<number>();
        const cardTypes = new Set<number>();

        // 具体卡片(成员卡/留影): 同一张卡可能有多条 eventBonusType 但数值相同, 按卡去重
        const byCard = new Map<string, EventBonusCard>();
        for (const row of rows) {
            const isMember = row.memberCardId > 0;
            if (!isMember && !row.supportCardId) continue;
            const key = `${isMember ? 'm' : 's'}-${isMember ? row.memberCardId : row.supportCardId}`;
            if (byCard.has(key)) continue;
            const ref = await resolveCard(this.server, isMember ? 2 : 3, isMember ? row.memberCardId : row.supportCardId, t);
            if (!ref) continue;
            byCard.set(key, { ...ref, bonusByRank: [row.rank1EffectValue, row.rank2EffectValue, row.rank3EffectValue, row.rank4EffectValue, row.rank5EffectValue].map(v => Math.round(Number(v ?? 0)) / 100) });
        }
        this.bonusCards = [...byCard.values()];

        // 条件行(按乐队/角色/属性): 同一条件的成员/支援两侧合并成一行
        const byCond = new Map<string, EventBonusCondition>();
        for (const row of rows) {
            if (row.bandId) bands.add(row.bandId);
            if (row.characterId) characters.add(row.characterId);
            if (row.cardType) cardTypes.add(row.cardType);
            if (row.memberCardId || row.supportCardId) continue;
            let label = '';
            if (row.bandId) {
                const band = await store.bandById(row.bandId);
                label = band ? await t(band.nameTextID) : `乐队#${row.bandId}`;
            } else if (row.characterId) {
                const character = await store.characterById(row.characterId);
                label = character ? await t(character.nameTextID) : `角色#${row.characterId}`;
            } else if (row.cardType) {
                label = `${await attributeName(this.server, row.cardType)}属性`;
            }
            if (!label) continue;
            const entry = byCond.get(label) ?? { label };
            const bonus = Math.round(Number(row.rank1EffectValue ?? 0)) / 100;
            if (row.resourceTypeConstraint === 3) entry.support = bonus;
            else entry.member = bonus;
            byCond.set(label, entry);
        }
        this.bonusConditions = [...byCond.values()];

        // 卡片自身的乐队/角色/属性也算进搜索维度, 这样按角色名也能搜到活动
        for (const card of this.bonusCards) {
            if (card.kind === 'member') {
                const row = await store.cardById(card.cardId);
                if (row?.characterID) {
                    characters.add(row.characterID);
                    const ch = await store.characterById(row.characterID);
                    if (ch?.bandID) bands.add(ch.bandID);
                }
                if (row?.cardType) cardTypes.add(row.cardType);
            } else {
                const row = await store.supportCardById(card.cardId);
                for (const cid of row?.characterIDs ?? []) {
                    characters.add(cid);
                    const ch = await store.characterById(cid);
                    if (ch?.bandID) bands.add(ch.bandID);
                }
                if (row?.cardType) cardTypes.add(row.cardType);
            }
        }

        this.bonusBandIds = [...bands];
        this.bonusCharacterIds = [...characters];
        this.bonusCardTypes = [...cardTypes];

        // 名称文本(供 _all 子串回退)
        for (const id of this.bonusBandIds) {
            const band = await store.bandById(id);
            if (band) this.bonusBandNames.push(await t(band.nameTextID));
        }
        for (const id of this.bonusCharacterIds) {
            const ch = await store.characterById(id);
            if (ch) this.bonusCharacterNames.push(await t(ch.nameTextID));
        }
    }

    private async loadEventCards(store: Store, t: TextFn): Promise<void> {
        const rows: EventPickupCardRow[] = await store.eventPickupCardsByEvent(this.eventId);
        for (const row of rows) {
            const ref = await resolveCard(this.server, row.resourceType, row.resourceId, t);
            if (ref) this.eventCards.push(ref);
        }
    }

    private async loadRewards(store: Store, t: TextFn): Promise<void> {
        const music = this.row?.musicId ? await store.songById(this.row.musicId) : undefined;
        const thresholds = await store.liveScoreRanksByGroup(music?.liveScoreRankGroup ?? 0);
        const thresholdOf = (rank: number) => thresholds.find(x => x.liveScoreRank === rank)?.requiredScore;

        // 演出报酬 = 该评级的活动点数(MasterLiveEventPoint) + 道具(MasterLiveEventReward)
        const pointByRank = new Map<number, number>((await store.liveEventPointsByGroup(this.row?.liveEventPointGroup ?? 0)).map(r => [r.scoreRank, r.value] as [number, number]));
        this.liveRewards = await this.buildRewardRows(
            store, t,
            await store.liveEventRewardsByGroup(this.row?.liveEventRewardGroup ?? 0),
            pointByRank, thresholdOf
        );

        // 挑战演出报酬: 同样两张表, 但用 MasterChallengeLive*
        const challengePointByRank = new Map<number, number>((await store.challengeLiveEventPointsByGroup(this.row?.challengeLiveEventPointGroup ?? 0)).map(r => [r.scoreRank, r.value] as [number, number]));
        this.challengeRewards = await this.buildRewardRows(
            store, t,
            await store.challengeLiveEventRewardsByGroup(this.row?.challengeLiveEventRewardGroup ?? 0),
            challengePointByRank, thresholdOf
        );

        await this.loadMilestones(store, t);
    }

    /** 把「每 rank 的多条道具」并成一行; 点数取自另一张表 */
    private async buildRewardRows(
        store: Store,
        t: TextFn,
        rows: Array<{ scoreRank: number; resourceType: number; resourceId: number; resourceCount: number }>,
        pointByRank: Map<number, number>,
        thresholdOf: (rank: number) => number | undefined
    ): Promise<EventLiveRewardRow[]> {
        const byRank = new Map<number, EventLiveRewardRow>();
        for (const row of rows) {
            let entry = byRank.get(row.scoreRank);
            if (!entry) {
                entry = { scoreRank: row.scoreRank, points: pointByRank.get(row.scoreRank) ?? 0, requiredScore: thresholdOf(row.scoreRank), items: [] };
                byRank.set(row.scoreRank, entry);
            }
            const item = await this.resolveReward(store, t, row.resourceType, row.resourceId, row.resourceCount);
            if (item) entry.items.push(item);
        }
        return [...byRank.values()].sort((a, b) => a.scoreRank - b.scoreRank);
    }

    /**
     * 累计点数奖励(里程碑)。
     * 表格**只保留**含星钻/幸运水晶/奇迹水晶/棱晶/角色卡/支援卡的档位(全量 78 档大半是金币与经验,
     * 全画出来会非常长); 而**总奖励不做筛选**, 把上面没列出的金币、经验、技能券等一并计入。
     */
    private async loadMilestones(store: Store, t: TextFn): Promise<void> {
        const rows = await store.achievementRewardsByEvent(this.eventId);
        if (!rows.length) return;
        const rewardMap = await store.rewardsByIds([...new Set(rows.flatMap(r => r.rewardIds ?? []))]);
        const totals = new Map<string, EventRewardItem>();

        for (const row of rows) {
            const listed: EventRewardItem[] = [];
            for (const rewardId of row.rewardIds ?? []) {
                const reward = rewardMap.get(rewardId);
                if (!reward) continue;
                const item = await this.resolveReward(store, t, reward.resourceType, reward.resourceId, reward.resourceCount);
                if (!item) continue;
                // 合计: 全部奖励
                const key = `${item.kind}-${item.id}`;
                const acc = totals.get(key);
                if (acc) acc.count += item.count;
                else totals.set(key, { ...item });
                // 表格: 只放筛选出来的那几类
                if (isWantedReward(item)) listed.push(item);
            }
            if (listed.length) this.pointMilestones.push({ point: row.eventPoint, rewards: listed });
        }
        // 按数量升序(即原先的降序反过来): 小数量的排前面
        this.totalRewards = [...totals.values()].sort((a, b) => a.count - b.count);
    }

    /** 把 (资源类型, 资源 id, 数量) 解析成可展示的奖励条目 */
    private async resolveReward(
        store: Store,
        t: TextFn,
        resourceType: number,
        resourceId: number,
        count: number
    ): Promise<EventRewardItem | undefined> {
        if (resourceType === 2 || resourceType === 3) {
            const ref = await resolveCard(this.server, resourceType, resourceId, t);
            return ref ? { kind: ref.kind, id: ref.cardId, name: ref.name, imagePath: '', count } : undefined;
        }
        if (resourceType !== 1) return undefined;
        const item = await store.itemById(resourceId);
        if (!item) return undefined;
        return { kind: 'item', id: item.id, name: await t(item.nameTextId), imagePath: item.imagePath, count };
    }

    // ---- 展示 ----

    status(now = new Date()): EventStatus {
        if (!this.startAt || !this.endAt) return 'ended';
        if (now < this.startAt) return 'upcoming';
        if (now > this.endAt) return 'ended';
        return 'open';
    }

    /** 总时长(毫秒) */
    durationMs(): number | undefined {
        if (!this.startAt || !this.endAt) return undefined;
        return this.endAt.getTime() - this.startAt.getTime();
    }

    /**
     * 活动「种类」标签。
     * 主数据没有种类名称表, 用活动自身的排名开关描述 —— 实测该活动为「乐曲排名 · 乐曲总排名」。
     */
    typeLabel(): string {
        const r = this.row;
        if (!r) return '未知种类';
        const parts: string[] = [];
        if (!r.isRankingDisabled) parts.push('综合排名');
        if (!r.isMusicRankingDisabled) parts.push('乐曲排名');
        if (!r.isTotalMusicRankingDisabled) parts.push('乐曲总排名');
        return parts.length ? parts.join(' · ') : '无排名';
    }

    /** 背景图用哪个团: 活动相关的团只有一个时才用, 多个团混合时退回通用背景 */
    backgroundBandId(): number | undefined {
        return this.bonusBandIds.length === 1 ? this.bonusBandIds[0] : undefined;
    }

    logoUrl(): string {
        return this.logoAsset ? eventLogoUrl(this.server, this.logoAsset) : '';
    }

    backgroundUrl(): string {
        return this.row?.backgroundAsset ? eventBackgroundUrl(this.server, String(this.row.backgroundAsset)) : '';
    }

    /** 供 match() 使用: 名称走 eventId, 角色/乐队/属性复用既有索引类型 */
    fuzzyTarget(): Record<string, unknown> {
        return {
            eventId: this.eventId,
            eventName: this.eventName,
            bandId: this.bonusBandIds,
            characterId: this.bonusCharacterIds,
            cardType: this.bonusCardTypes,
            // 下面的字符串字段供 _all(子串)回退使用
            bonusLabels: this.bonusConditions.map(c => c.label),
            bandName: this.bonusBandNames,
            characterName: this.bonusCharacterNames
        };
    }
}

/**
 * 里程碑奖励的筛选: 只保留这几类。
 * 判断依据用**道具图标的路径**而不是 id 区间 —— id 会随版本变动, 图标分类稳定:
 * - `Item/common/item_icon_star`  星钻(注意不含 `_purchase` 有偿星钻)
 * - `Item/crystal/*`              幸运水晶 / 奇迹水晶
 * - `Item/prism/*`                各团棱晶 / 希望棱晶
 * - 角色卡(resourceType 2) / 支援卡(resourceType 3)
 */
function isWantedReward(item: EventRewardItem): boolean {
    if (item.kind !== 'item') return true;
    const p = item.imagePath;
    return p === 'Item/common/item_icon_star'
        || p.startsWith('Item/crystal/')
        || p.startsWith('Item/prism/');
}

/** 按资源类型取出成员卡/留影的展示信息 */
async function resolveCard(server: Server, resourceType: number, resourceId: number, t: TextFn): Promise<EventCardRef | undefined> {
    const { store } = regionFor(server);
    if (resourceType === 3) {
        const card = await store.supportCardById(resourceId);
        if (!card) return undefined;
        return { kind: 'support', cardId: card.id, name: await t(card.nameTextID), assetId: card.assetID };
    }
    const card = await store.cardById(resourceId);
    if (!card) return undefined;
    return { kind: 'member', cardId: card.id, name: await t(card.nameTextID), assetId: card.assetID };
}
