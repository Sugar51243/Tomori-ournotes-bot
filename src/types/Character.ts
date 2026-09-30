import { CharacterRow } from './MasterData';
import { regionFor } from '../data/region';
import { characterIconUrl, characterSpriteUrl } from '../data/assets';
import { Band } from './Band';
import { config } from '../config';
import { Server, defaultServer, withServer } from './Server';

export class Character {
    characterId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: CharacterRow;
    characterName = '';
    shortName = '';
    enName = '';
    bandId = 0;
    bandName = '';
    bandPart = '';
    birthdayMonth = 0;
    birthdayDay = 0;
    voiceActor = '';
    description = '';
    mainColorCode = '#888888';
    subColorCode = '#FFFFFF';
    /** 宣传语 */
    catchCopy = '';
    height = '';
    constellation = '';
    school = '';
    schoolClass = '';
    hobby = '';
    favoriteFood = '';
    playable = true;

    constructor(characterId: number) {
        this.characterId = characterId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.characterById(this.characterId);
        if (!this.row) return;
        this.isExist = true;
        this.characterName = await t(this.row.nameTextID);
        this.shortName = await t(this.row.shortNameTextID);
        // enDisplayNameTextId 是"本地化别名"行(ja 列为罗马音、en 列为汉字名), 按当前语言回退链取用:
        // 简中即得 "Tomori Takamatsu" 这类罗马音, 强制 'en' 反而会取到汉字名
        this.enName = await t(this.row.enDisplayNameTextId);
        this.bandId = this.row.bandID;
        this.bandPart = this.row.bandPart;
        this.birthdayMonth = this.row.birthdayMonth;
        this.birthdayDay = this.row.birthdayDay;
        this.voiceActor = await t(this.row.voiceActorTextId);
        this.description = await t(this.row.descriptionTextId);
        this.mainColorCode = this.row.mainColorCode || '#888888';
        this.subColorCode = this.row.subColorCode || '#FFFFFF';
        this.catchCopy = this.row.catchCopyTextId ? await t(this.row.catchCopyTextId) : '';
        this.height = this.row.heightTextId ? await t(this.row.heightTextId) : '';
        this.constellation = this.row.constellationTextId ? await t(this.row.constellationTextId) : '';
        this.school = this.row.schoolTextId ? await t(this.row.schoolTextId) : '';
        this.schoolClass = this.row.schoolClassTextId ? await t(this.row.schoolClassTextId) : '';
        this.hobby = this.row.hobbyTextId ? await t(this.row.hobbyTextId) : '';
        this.favoriteFood = this.row.favoriteFoodTextId ? await t(this.row.favoriteFoodTextId) : '';
        this.playable = !this.row.isNonPlayable;
        const band = withServer(new Band(this.bandId), this.server);
        await band.init();
        this.bandName = band.bandName;
    }

    iconUrl(): string {
        return characterIconUrl(this.server, this.characterId);
    }

    spriteUrl(): string {
        return characterSpriteUrl(this.server, this.characterId);
    }

    fuzzyTarget(): Record<string, unknown> {
        return {
            characterId: this.characterId,
            characterName: this.characterName,
            bandName: this.bandName,
            // 乐团分类
            bandId: this.bandId
        };
    }
}
