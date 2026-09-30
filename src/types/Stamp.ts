import { StampRow } from './MasterData';
import { regionFor } from '../data/region';
import { stampUrl } from '../data/assets';
import { Server, defaultServer } from './Server';

/** 贴纸分类(主数据里以数字给出) */
export const stampCategoryNames: Record<number, string> = {
    1: '角色贴纸',
    2: '文字贴纸',
    3: '稀有贴纸'
};

/**
 * 贴纸模型。
 * 与其它领域模型一致: 构造函数只收 id, 区域是构造后的字段(默认主服)。
 */
export class Stamp {
    stampId: number;
    /** 该实体由哪个区域渲染(文本/素材来源) */
    server: Server = defaultServer();
    isExist = false;
    row?: StampRow;
    name = '';
    /** 1=角色贴纸 2=文字贴纸 3=稀有贴纸 */
    category = 0;
    /** 归属角色(文字贴纸为空) */
    characterIds: number[] = [];
    characterNames: string[] = [];
    /** 归属角色所属的团体; 一个角色只属一个团体, 故通常只有一个 */
    bandIds: number[] = [];
    bandNames: string[] = [];
    stampAsset = '';

    constructor(stampId: number) {
        this.stampId = stampId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.stampById(this.stampId);
        if (!this.row) return;
        this.isExist = true;
        this.stampAsset = this.row.stampAsset ?? '';
        this.category = this.row.stampCategory ?? 0;
        this.name = this.row.nameTextId ? await t(this.row.nameTextId) : `贴纸#${this.stampId}`;

        // 角色 -> 团体: 贴纸本身只有角色归属, 团体要靠角色反查
        const bandIds = new Set<number>();
        for (const id of this.row.characterIds ?? []) {
            const character = await store.characterById(id);
            if (!character) continue;
            this.characterIds.push(id);
            this.characterNames.push(await t(character.nameTextID));
            if (character.bandID) {
                if (!bandIds.has(character.bandID)) {
                    bandIds.add(character.bandID);
                    const band = await store.bandById(character.bandID);
                    this.bandNames.push(band ? await t(band.nameTextID) : '');
                }
            }
        }
        this.bandIds = [...bandIds];
        this.bandNames = this.bandNames.filter(Boolean);
    }

    url(): string {
        return this.stampAsset ? stampUrl(this.server, this.stampAsset) : '';
    }

    categoryLabel(): string {
        return stampCategoryNames[this.category] ?? '贴纸';
    }

    /**
     * 供 match() 使用的模糊搜索目标。
     * - `stampId`(数字)用于「关键词命中贴纸名」: 索引里 stampId 类型存的是名称别名, 命中后 matches 里是贴纸 id
     * - `characterId` / `bandId`(数字数组)用于「关键词命中角色名/团体名」:
     *   索引里 characterId / bandId 类型存的是名称别名, 命中后 matches 里是对应的角色/团体 id
     * - 字符串字段供 fuzzySearch 的 `_all`(子串)回退使用
     */
    fuzzyTarget(): Record<string, unknown> {
        return {
            stampId: this.stampId,
            stampName: this.name,
            characterId: this.characterIds,
            characterName: this.characterNames,
            bandId: this.bandIds,
            bandName: this.bandNames
        };
    }
}

/** 按搜索范围取对应的匹配目标: 限定范围时只暴露该范围相关的字段 */
export function stampTargetForScope(stamp: Stamp, scope: 'all' | 'character' | 'band'): Record<string, unknown> {
    if (scope === 'character') {
        return { characterId: stamp.characterIds, characterName: stamp.characterNames };
    }
    if (scope === 'band') {
        return { bandId: stamp.bandIds, bandName: stamp.bandNames };
    }
    return stamp.fuzzyTarget();
}
