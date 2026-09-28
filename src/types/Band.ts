import { BandRow } from './MasterData';
import { store, t } from '../data/masterdata';
import { bandLogoUrl } from '../data/assets';

export class Band {
    bandId: number;
    isExist = false;
    row?: BandRow;
    bandName = '';
    mainColorCode = '#888888';
    subColorCode = '#FFFFFF';

    constructor(bandId: number) {
        this.bandId = bandId;
    }

    async init(): Promise<void> {
        this.row = await store.bandById(this.bandId);
        if (!this.row) return;
        this.isExist = true;
        this.bandName = await t(this.row.nameTextID);
        this.mainColorCode = this.row.mainColorCode || '#888888';
        this.subColorCode = this.row.subColorCode || '#FFFFFF';
    }

    logoUrl(): string {
        return bandLogoUrl(this.bandId);
    }
}
