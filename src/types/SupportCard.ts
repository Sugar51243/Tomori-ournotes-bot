import { SupportCardRow, ItemRow } from './MasterData';
import { regionFor } from '../data/region';
import { supportCardThumbUrl, supportCardFullUrl, itemIconUrl } from '../data/assets';
import { rarityNames, attributeName } from './Card';
import { getSkills, getMaxLevel, SkillInfo } from '../data/skills';
import { config } from '../config';
import { Server, defaultServer } from './Server';

export class SupportCard {
    supportCardId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: SupportCardRow;
    cardName = '';
    rarity = 0;
    assetId = 0;
    cardType = 0;
    attribute = '';
    characterIds: number[] = [];
    characterNames: string[] = [];
    /** 关联角色归属的乐队 id(用于背景图) */
    bandId = 0;
    performancePowerMax = 0;
    technicPowerMax = 0;
    visualPowerMax = 0;
    startAt = '';
    description = '';
    maxLevel?: number;
    /** 支援技能 / 击奏支援技能(按最高等级套值) */
    skills: SkillInfo[] = [];

    constructor(supportCardId: number) {
        this.supportCardId = supportCardId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.supportCardById(this.supportCardId);
        if (!this.row) return;
        this.isExist = true;
        this.cardName = await t(this.row.nameTextID);
        this.rarity = this.row.rarity;
        this.assetId = this.row.assetID;
        this.cardType = this.row.cardType;
        this.attribute = await attributeName(this.server, this.row.cardType);
        this.characterIds = this.row.characterIDs ?? [];
        for (const cid of this.characterIds) {
            const ch = await store.characterById(cid);
            if (!ch) continue;
            this.characterNames.push(await t(ch.nameTextID));
            if (!this.bandId && ch.bandID) this.bandId = ch.bandID;
        }
        this.performancePowerMax = Number(this.row.performancePowerMax ?? 0);
        this.technicPowerMax = Number(this.row.technicPowerMax ?? 0);
        this.visualPowerMax = Number(this.row.visualPowerMax ?? 0);
        this.startAt = String(this.row.startAt ?? '');
        const descId = String(this.row.descriptionTextID ?? '');
        this.description = descId ? await t(descId) : '';
        this.maxLevel = await getMaxLevel(this.server, 'MasterSupportCardLevel', this.row.supportCardLevelGroup ?? 0).catch(() => undefined);
        this.skills = await getSkills(this.server, [
            ['support', this.row.supportSkillId01, '支援技能'],
            ['support', this.row.supportSkillId02, '支援技能'],
            ['support', this.row.gekisouSupportSkillId01, '击奏支援技能'],
            ['support', this.row.gekisouSupportSkillId02, '击奏支援技能']
        ]).catch(() => []);
    }

    totalPower(): number {
        return this.performancePowerMax + this.technicPowerMax + this.visualPowerMax;
    }

    thumbUrl(): string {
        return supportCardThumbUrl(this.server, this.assetId);
    }

    fullUrl(): string {
        return supportCardFullUrl(this.server, this.assetId);
    }

    rarityLabel(): string {
        return rarityNames[this.rarity] ?? `${this.rarity}★`;
    }

    /** 供 match() 使用的模糊搜索目标(键名与 index 中注册的类型对应) */
    fuzzyTarget(): Record<string, unknown> {
        return {
            supportCardId: this.supportCardId,
            cardName: this.cardName,
            characterName: this.characterNames,
            // 兼按角色/乐团分类命中(留影可关联多个角色)
            characterId: this.characterIds,
            bandId: this.bandId
        };
    }
}

export class Item {
    itemId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: ItemRow;
    itemName = '';
    imagePath = '';

    constructor(itemId: number) {
        this.itemId = itemId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.itemById(this.itemId);
        if (!this.row) return;
        this.isExist = true;
        this.itemName = await t(this.row.nameTextId);
        this.imagePath = this.row.imagePath;
    }

    iconUrl(): string {
        return itemIconUrl(this.server, this.imagePath);
    }
}
