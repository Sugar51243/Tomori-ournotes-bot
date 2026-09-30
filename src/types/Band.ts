import { BandRow } from './MasterData';
import { regionFor } from '../data/region';
import { bandLogoUrl } from '../data/assets';
import { config } from '../config';
import { Server, defaultServer } from './Server';

export class Band {
    bandId: number;
    /** 该实体由哪个区域渲染(文本/素材来源); 默认主服, 由调用方在 init() 前指定 */
    server: Server = defaultServer();
    isExist = false;
    row?: BandRow;
    bandName = '';
    mainColorCode = '#888888';
    subColorCode = '#FFFFFF';

    constructor(bandId: number) {
        this.bandId = bandId;
    }

    async init(): Promise<void> {
        const { store, t } = regionFor(this.server);
        this.row = await store.bandById(this.bandId);
        if (!this.row) return;
        this.isExist = true;
        this.bandName = await t(this.row.nameTextID);
        this.mainColorCode = this.row.mainColorCode || '#888888';
        this.subColorCode = this.row.subColorCode || '#FFFFFF';
    }

    logoUrl(): string {
        return bandLogoUrl(this.server, this.bandId);
    }
}
