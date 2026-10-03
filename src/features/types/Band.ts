import { BandRow } from './MasterData';
import { regionFor } from '../../db/adapter';
import { bandLogoUrl } from '../../upstream/adapter';
import { config } from '../../config';
import { Server, defaultServer } from './Server';

/** 乐团领域模型: init() 从该服 master 表装载信息 */
export class Band {
    bandId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: BandRow;
    bandName = '';
    /** 乐团简介 */
    description = '';
    mainColorCode = '#888888';
    subColorCode = '#FFFFFF';
    /** 成员(角色 id + 本地化名字), 按角色 id 升序 */
    members: Array<{ id: number; name: string }> = [];

    constructor(bandId: number) {
        this.bandId = bandId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.bandById(this.bandId);
        if (!this.row) return;
        this.isExist = true;
        this.bandName = await t(this.row.nameTextID);
        this.description = this.row.descriptionTextID ? await t(this.row.descriptionTextID) : '';
        this.mainColorCode = this.row.mainColorCode || '#888888';
        this.subColorCode = this.row.subColorCode || '#FFFFFF';

        // 成员 = 该乐团下的角色(MasterCharacter.bandID)
        const characters = await store.characters().catch(() => []);
        for (const c of characters.filter(x => Number(x.bandID) === this.bandId).sort((a, b) => Number(a.id) - Number(b.id))) {
            this.members.push({ id: Number(c.id), name: await t(c.nameTextID) });
        }
    }

    logoUrl(): string {
        return bandLogoUrl(this.server, this.bandId);
    }

    /** 供 match() 使用: 乐团名 + 乐团分类 id */
    fuzzyTarget(): Record<string, unknown> {
        return {
            bandId: this.bandId,
            bandName: this.bandName
        };
    }
}
