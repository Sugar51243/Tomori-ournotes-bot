// master 表行类型(键已剥离 _ 前缀)。字段名与 metadata.bdon.moe 一致, 未列出的字段可通过 [key: string]: unknown 访问。

export interface LiveMusicRow {
    id: number;
    sortOrder: number;
    titleTextID: string;
    /** 假名/罗马音标题(如 Mayoiuta) */
    phoneticTextID: string;
    bandIDs: number[];
    /** 演唱角色 id 列表 */
    vocalCharacterIDs: number[];
    /** 音乐分类 id(对应 MasterLiveMusicCategory) */
    musicCategories: number[];
    /** 应援色 id(对应 MasterLiveMusicPenLightColor) */
    liveMusicPenLightColorID: number;
    /** 非参战乐队(如 CRYCHIC)的乐队名文本 ID, bandIDs 为空时使用 */
    bandNameTextID: string;
    musicType: number;
    easyID: number;
    normalID: number;
    hardID: number;
    expertID: number;
    jacketAssetName: string;
    /** 评分等级组(对应 MasterLiveScoreRank.group), 活动奖励的分数门槛靠它查 */
    liveScoreRankGroup: number;
    lyricistTextID: string;
    composerTextID: string;
    arrangerTextID: string;
    startAt: string;
    [key: string]: unknown;
}

export interface LiveMusicScoreRow {
    id: number;
    musicScoreTextFileName: string;   // 如 "0001/0001_03"
    musicScoreLevel: number;
    musicScoreDisplayLevel: number;
    fullComboCount: number;
    [key: string]: unknown;
}

export interface BandRow {
    id: number;
    nameTextID: string;
    descriptionTextID: string;
    mainColorCode: string;
    subColorCode: string;
    [key: string]: unknown;
}

export interface CharacterRow {
    id: number;
    nameTextID: string;
    shortNameTextID: string;
    enDisplayNameTextId: string;
    enDisplayShortNameTextId: string;
    bandID: number;
    displayOrder: number;
    mainColorCode: string;
    subColorCode: string;
    instrumentTypes: number[];
    bandPart: string;
    birthdayMonth: number;
    birthdayDay: number;
    voiceActorTextId: string;
    descriptionTextId: string;
    catchCopyTextId: string;
    heightTextId: string;
    constellationTextId: string;
    schoolTextId: string;
    schoolClassTextId: string;
    hobbyTextId: string;
    favoriteFoodTextId: string;
    isNonPlayable: boolean;
    [key: string]: unknown;
}

export interface MemberCardRow {
    id: number;
    assetID: number;
    nameTextID: string;
    subtitleTextID: string;
    characterID: number;
    rarity: number;          // 2=R 3=SR 4=SSR
    cardType: number;        // 1=Red 2=Blue 3=Green 4=Yellow 5=Purple(参考 moenotes)
    bestMusicTagIDs: number[];
    performancePowerMax: number;
    technicPowerMax: number;
    visualPowerMax: number;
    leaderSkillID: number;
    liveSkillID: number;
    gekisouSkillID: number;
    memberCardLevelGroup: number;
    startAt: string;
    [key: string]: unknown;
}

export interface GachaLotRow {
    id: number;
    lotGroupId: number;
    /** 稀有度约束: 2=R 3=SR 4=SSR 0=无(道具) */
    rarityConstraint: number;
    /** 资源类型约束: 1=道具 2=成员卡 3=支援卡 */
    resourceTypeConstraint: number;
    prizeGroupId: number;
    weight: number;
    [key: string]: unknown;
}

export interface GachaPrizeRow {
    id: number;
    groupId: number;
    /** 1=道具 2=成员卡 3=支援卡 */
    resourceType: number;
    resourceId: number;
    amount: number;
    /** 1=普通 2=UP */
    pickUpType: number;
    pickUpAddedRate: number;
    /** UP 卡固定权重(>0 时使用) */
    pickUpFixedRate: number;
    [key: string]: unknown;
}

export interface SupportCardRow {
    id: number;
    assetID: number;
    nameTextID: string;
    descriptionTextID: string;
    diaryTextID: string;
    characterIDs: number[];
    rarity: number;
    cardType: number;
    performancePowerMax: number;
    technicPowerMax: number;
    visualPowerMax: number;
    supportCardLevelGroup: number;
    supportSkillId01: number;
    supportSkillId02: number;
    gekisouSupportSkillId01: number;
    gekisouSupportSkillId02: number;
    startAt: string;
    [key: string]: unknown;
}

export interface ItemRow {
    id: number;
    nameTextId: string;
    imagePath: string;
    [key: string]: unknown;
}

/** 贴纸(MasterStamp): 素材路径形如 "Stamp/illust/stamp_illust_tomori_001" 或 "Stamp/text/stamp_text_001" */
export interface StampRow {
    id: number;
    nameTextId: string;
    /** 1=角色贴纸 2=文字贴纸 3=稀有贴纸 */
    stampCategory: number;
    priority: number;
    /** 注意是小写 d —— MasterStamp 用 `_characterIds`, 而 MasterSupportCard 用 `_characterIDs`(大写 D) */
    characterIds: number[];
    isInitialOwnership: boolean;
    stampAsset: string;
    voiceAsset: string;
    startAt: string;
    endAt: string;
    [key: string]: unknown;
}

export interface GachaRow {
    id: number;
    nameTextId: string;
    appealTextId: string;
    descriptionTextId: string;
    gachaTicketItemId: number;
    /** 关联 MasterGachaLot.lotGroupId */
    lotGroupId: number;
    bannerAssetName: string;
    logoAssetName: string;
    startAt: string;
    endAt: string;
    priority: number;
    isLimited: boolean;
    isNewMember: boolean;
    stepUpId: number;
    ceilingIds: number[];
    showPrizeRatio: boolean;
    [key: string]: unknown;
}

export interface MusicCategoryRow {
    id: number;
    musicCategories: number[];
    textKey: string;
    [key: string]: unknown;
}

export interface PenLightColorRow {
    id: number;
    mainColor: string;
    mainQuantityRatio: number;
    sub1Color: string;
    sub2Color: string;
    sub3Color: string;
    sub4Color: string;
    [key: string]: unknown;
}

export interface EventRow {
    id: number;
    nameTextId: string;
    startAt: string;
    endAt: string;
    /** 展示用结束时间(比 endAt 晚, 用于结算展示) */
    displayEndAt: string;
    /** 活动种类; 实测只有 jp 有数据且当前仅观测到 1 */
    eventType: number;
    /** 活动道具 -> MasterItem */
    eventItemId: number;
    /** 演出报酬组 -> MasterLiveEventReward.eventGroup */
    liveEventRewardGroup: number;
    /** 点数奖励组 -> MasterLiveEventPoint.group */
    liveEventPointGroup: number;
    challengeLiveEventRewardGroup: number;
    challengeLiveEventPointGroup: number;
    /** 活动曲 -> MasterLiveMusic */
    musicId: number;
    logoAsset: string;
    backgroundAsset: string;
    bannerAsset: string;
    /** 排名开关; 用来描述这个活动「有哪些排名」(主数据里没有种类名称表) */
    isRankingDisabled: boolean;
    isMusicRankingDisabled: boolean;
    isTotalMusicRankingDisabled: boolean;
    [key: string]: unknown;
}

/** 活动加成(MasterEventEffect): 具体卡片行带 memberCardId/supportCardId, 条件行带 bandId/cardType 等 */
export interface EventEffectRow {
    id: number;
    eventId: number;
    /** 2=成员卡 3=支援卡 */
    resourceTypeConstraint: number;
    characterId: number;
    bandId: number;
    /** 卡片属性(1 红 2 蓝 3 绿 4 黄 5 紫) */
    cardType: number;
    tagId: number;
    memberCardId: number;
    supportCardId: number;
    eventBonusType: number;
    rank1EffectValue: number;
    rank2EffectValue: number;
    rank3EffectValue: number;
    rank4EffectValue: number;
    rank5EffectValue: number;
    [key: string]: unknown;
}

/** 活动卡牌(MasterEventPickUpCard) */
export interface EventPickupCardRow {
    id: number;
    eventId: number;
    /** 2=成员卡 3=支援卡 */
    resourceType: number;
    resourceId: number;
    [key: string]: unknown;
}

/** 活动歌曲(MasterChallengeMusic) */
export interface ChallengeMusicRow {
    id: number;
    eventId: number;
    liveMusicId: number;
    musicType: number;
    [key: string]: unknown;
}

/** 点数奖励(MasterLiveEventPoint) */
export interface LiveEventPointRow {
    id: number;
    group: number;
    /** 评分等级(对应 MasterLiveScoreRank.liveScoreRank) */
    scoreRank: number;
    value: number;
    [key: string]: unknown;
}

/** 演出报酬(MasterLiveEventReward) */
export interface LiveEventRewardRow {
    id: number;
    eventGroup: number;
    group: number;
    scoreRank: number;
    /** 1=道具 等 */
    resourceType: number;
    resourceId: number;
    resourceCount: number;
    probability: number;
    [key: string]: unknown;
}

/** 评分等级门槛(MasterLiveScoreRank) */
export interface LiveScoreRankRow {
    id: number;
    group: number;
    liveScoreRank: number;
    requiredScore: number;
    [key: string]: unknown;
}

/** 累计点数奖励(MasterEventAchievementReward): 达到 eventPoint 给 rewardIds */
export interface EventAchievementRewardRow {
    id: number;
    eventId: number;
    eventPoint: number;
    rewardIds: number[];
    [key: string]: unknown;
}

/** 挑战演出点数(MasterChallengeLiveEventPoint) */
export interface ChallengeLiveEventPointRow {
    id: number;
    group: number;
    scoreRank: number;
    value: number;
    [key: string]: unknown;
}

/** 挑战演出报酬(MasterChallengeLiveEventReward) */
export interface ChallengeLiveEventRewardRow {
    id: number;
    eventGroup: number;
    group: number;
    scoreRank: number;
    resourceType: number;
    resourceId: number;
    resourceCount: number;
    probability: number;
    [key: string]: unknown;
}

/** 奖励条目(MasterReward) */
export interface RewardRow {
    id: number;
    resourceType: number;
    resourceId: number;
    resourceCount: number;
    [key: string]: unknown;
}

export interface TextRow {
    id: string;
    japanese: string;
    english: string;
    traditionalChinese: string;
    simplifiedChinese: string;
    korean: string;
    [key: string]: string;
}
