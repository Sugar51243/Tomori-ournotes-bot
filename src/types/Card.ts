import { MemberCardRow } from './MasterData';
import { regionFor } from '../data/region';
import { cardFullArtUrl, cardThumbUrl } from '../data/assets';
import { Character } from './Character';
import { getSkills, getMaxLevel, SkillInfo } from '../data/skills';
import { config } from '../config';
import { Server, defaultServer, withServer } from './Server';

export const cardTypeNames: Record<number, string> = {
    1: 'Red', 2: 'Blue', 3: 'Green', 4: 'Yellow', 5: 'Purple'
};
export const cardTypeColors: Record<number, string> = {
    1: '#ff5560', 2: '#44aaff', 3: '#44dd77', 4: '#ffbb33', 5: '#bb66ff'
};
export const rarityNames: Record<number, string> = {
    2: 'R', 3: 'SR', 4: 'SSR', 10: 'EX'
};
/** 官方属性名文本 id(简中如"绯红属性/绀碧属性/翡翠属性/琉金属性/紫苑属性") */
export const cardTypeTextIds: Record<number, string> = {
    1: 'CardType_Red_Name',
    2: 'CardType_Blue_Name',
    3: 'CardType_Green_Name',
    4: 'CardType_Yellow_Name',
    5: 'CardType_Purple_Name'
};

/** 属性名(优先官方本地化文本并去掉"属性/タイプ/Type"等后缀, 缺失时退回颜色名) */
export async function attributeName(server: Server, cardType: number): Promise<string> {
    const textId = cardTypeTextIds[cardType];
    if (textId) {
        const name = await regionFor(server).t(textId);
        if (name && name !== textId) {
            // 官方名形如 绯红属性 / 緋紅屬性 / 紅赤タイプ / Ruby Type / 레드 타입
            const stripped = name.replace(/\s*(属性|屬性|タイプ|타입|types?|type)$/i, '').trim();
            if (stripped) return stripped;
        }
    }
    return cardTypeNames[cardType] ?? String(cardType);
}

export class Card {
    cardId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: MemberCardRow;
    cardName = '';
    subtitle = '';
    characterId = 0;
    characterName = '';
    /** 所属角色归属的乐队 id(用于背景图) */
    bandId = 0;
    rarity = 0;
    cardType = 0;
    attribute = '';
    performancePowerMax = 0;
    technicPowerMax = 0;
    visualPowerMax = 0;
    assetId = 0;
    startAt = '';
    maxLevel?: number;
    /** 队长/演出/击奏技能(按最高等级套值) */
    skills: SkillInfo[] = [];

    constructor(cardId: number) {
        this.cardId = cardId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.cardById(this.cardId);
        if (!this.row) return;
        this.isExist = true;
        this.cardName = await t(this.row.nameTextID);
        this.subtitle = await t(this.row.subtitleTextID);
        this.characterId = this.row.characterID;
        this.rarity = this.row.rarity;
        this.cardType = this.row.cardType;
        this.attribute = await attributeName(this.server, this.row.cardType);
        this.performancePowerMax = this.row.performancePowerMax;
        this.technicPowerMax = this.row.technicPowerMax;
        this.visualPowerMax = this.row.visualPowerMax;
        this.assetId = this.row.assetID;
        this.startAt = String(this.row.startAt ?? '');
        const character = withServer(new Character(this.characterId), this.server);
        await character.init();
        this.characterName = character.characterName;
        this.bandId = character.bandId;
        // 等级上限与技能(技能解析较慢, 失败不影响卡片本身)
        this.maxLevel = await getMaxLevel(this.server, 'MasterMemberCardLevel', this.row.memberCardLevelGroup ?? 0).catch(() => undefined);
        this.skills = await getSkills(this.server, [
            ['leader', this.row.leaderSkillID, '队长技能'],
            ['live', this.row.liveSkillID, '演出技能'],
            ['gekisou', this.row.gekisouSkillID, '击奏技能']
        ]).catch(() => []);
    }

    totalPower(): number {
        return this.performancePowerMax + this.technicPowerMax + this.visualPowerMax;
    }

    fullArtUrl(): string {
        return cardFullArtUrl(this.server, this.cardId);
    }

    thumbUrl(): string {
        return cardThumbUrl(this.server, this.cardId);
    }

    rarityLabel(): string {
        return rarityNames[this.rarity] ?? `${this.rarity}★`;
    }

    fuzzyTarget(): Record<string, unknown> {
        return {
            cardId: this.cardId,
            cardName: this.cardName,
            characterId: this.characterId,
            characterName: this.characterName,
            rarityLabel: this.rarityLabel(),
            // 稀有度数值维度(索引把 r/sr/ssr/ex 与 4星/★4 解析成 cardRarity, 精确匹配)
            cardRarity: this.rarity,
            // 卡片属性: 索引里「绯红/绀碧/…」解析成 cardType 的 1..5(attribute 是同一属性的本地化名, 供子串回退)
            cardType: this.cardType,
            attribute: this.attribute,
            // 乐团分类(角色所属乐队)
            bandId: this.bandId
        };
    }
}
