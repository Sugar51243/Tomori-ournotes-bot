import { masterdataClient } from './client';
import { t, tSync, preloadText, resetTextCache } from './text';
import { resetSkillCache } from '../skills';
import {
    LiveMusicRow, LiveMusicScoreRow, BandRow, CharacterRow,
    MemberCardRow, GachaRow, EventRow, GachaLotRow, GachaPrizeRow,
    SupportCardRow, ItemRow, MusicCategoryRow, PenLightColorRow, StampRow
} from '../../types/MasterData';
import { logger } from '../../logger';

/**
 * MasterDataStore 门面: 各类表懒加载 + 常用查找。
 * dataVersion 变化时由 refresh() 重置文本缓存与各表引用(懒加载重新拉取)。
 */
class MasterDataStore {
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

    async refresh(): Promise<void> {
        const changed = await masterdataClient.refreshIfVersionChanged();
        if (changed) {
            this.liveMusic = this.liveMusicScore = this.bands = this.characterRows = this.cards = undefined;
            this.gachas = this.events = this.gachaLots = this.gachaPrizes = this.supportCards = this.items = this.stamps = undefined;
            resetTextCache();
            resetSkillCache();
            logger('masterdata', 'store reset, tables will be lazily reloaded');
        }
    }

    async songs(): Promise<LiveMusicRow[]> {
        this.liveMusic ??= await masterdataClient.getTable<LiveMusicRow>('MasterLiveMusic');
        return this.liveMusic;
    }

    async songById(id: number): Promise<LiveMusicRow | undefined> {
        return (await this.songs()).find(s => s.id === id);
    }

    async songScores(): Promise<LiveMusicScoreRow[]> {
        this.liveMusicScore ??= await masterdataClient.getTable<LiveMusicScoreRow>('MasterLiveMusicScore');
        return this.liveMusicScore;
    }

    /** musicId*100 + difficultyId(0-3) -> 分数行 */
    async scoreByChartId(chartId: number): Promise<LiveMusicScoreRow | undefined> {
        return (await this.songScores()).find(s => s.id === chartId);
    }

    async bandList(): Promise<BandRow[]> {
        this.bands ??= await masterdataClient.getTable<BandRow>('MasterBand');
        return this.bands;
    }

    async bandById(id: number): Promise<BandRow | undefined> {
        return (await this.bandList()).find(b => b.id === id);
    }

    async characters(): Promise<CharacterRow[]> {
        this.characterRows ??= await masterdataClient.getTable<CharacterRow>('MasterCharacter');
        return this.characterRows;
    }

    async characterById(id: number): Promise<CharacterRow | undefined> {
        return (await this.characters()).find(c => c.id === id);
    }

    async cardList(): Promise<MemberCardRow[]> {
        this.cards ??= await masterdataClient.getTable<MemberCardRow>('MasterMemberCard');
        return this.cards;
    }

    async cardById(id: number): Promise<MemberCardRow | undefined> {
        return (await this.cardList()).find(c => c.id === id);
    }

    async gachaList(): Promise<GachaRow[]> {
        this.gachas ??= await masterdataClient.getTable<GachaRow>('MasterGacha');
        return this.gachas;
    }

    async gachaById(id: number): Promise<GachaRow | undefined> {
        return (await this.gachaList()).find(g => g.id === id);
    }

    async eventList(): Promise<EventRow[]> {
        this.events ??= await masterdataClient.getTable<EventRow>('MasterEvent');
        return this.events;
    }

    async eventById(id: number): Promise<EventRow | undefined> {
        return (await this.eventList()).find(e => e.id === id);
    }

    /** 卡池抽奖组(真实概率数据) */
    async gachaLotList(): Promise<GachaLotRow[]> {
        this.gachaLots ??= await masterdataClient.getTable<GachaLotRow>('MasterGachaLot');
        return this.gachaLots;
    }

    async gachaLotsByGroup(lotGroupId: number): Promise<GachaLotRow[]> {
        return (await this.gachaLotList()).filter(l => l.lotGroupId === lotGroupId);
    }

    /** 卡池奖品(组内资源清单) */
    async gachaPrizeList(): Promise<GachaPrizeRow[]> {
        this.gachaPrizes ??= await masterdataClient.getTable<GachaPrizeRow>('MasterGachaPrize');
        return this.gachaPrizes;
    }

    async gachaPrizesByGroup(groupId: number): Promise<GachaPrizeRow[]> {
        return (await this.gachaPrizeList()).filter(p => p.groupId === groupId);
    }

    async supportCardList(): Promise<SupportCardRow[]> {
        this.supportCards ??= await masterdataClient.getTable<SupportCardRow>('MasterSupportCard');
        return this.supportCards;
    }

    async supportCardById(id: number): Promise<SupportCardRow | undefined> {
        return (await this.supportCardList()).find(c => c.id === id);
    }

    async itemList(): Promise<ItemRow[]> {
        this.items ??= await masterdataClient.getTable<ItemRow>('MasterItem');
        return this.items;
    }

    async itemById(id: number): Promise<ItemRow | undefined> {
        return (await this.itemList()).find(i => i.id === id);
    }

    async stampList(): Promise<StampRow[]> {
        this.stamps ??= await masterdataClient.getTable<StampRow>('MasterStamp');
        return this.stamps;
    }

    async stampById(id: number): Promise<StampRow | undefined> {
        return (await this.stampList()).find(s => s.id === id);
    }

    /** 道具名称(战斗道具/招募券等) */
    async itemName(id: number): Promise<string> {
        if (!id) return '';
        const row = await this.itemById(id);
        return row ? await t(row.nameTextId) : '';
    }

    /** 音乐分类名称(按分类 id 列表, 取其中一条分类行的本地化文本) */
    async musicCategoryNames(categoryIds: number[]): Promise<string[]> {
        if (!categoryIds?.length) return [];
        const rows = await masterdataClient.getTable<MusicCategoryRow>('MasterLiveMusicCategory').catch(() => []);
        const names: string[] = [];
        for (const id of categoryIds) {
            const row = rows.find(r => (r.musicCategories ?? []).includes(id));
            if (!row) continue;
            const name = await t(row.textKey);
            if (name && name !== row.textKey) names.push(name);
        }
        return names;
    }

    /** 应援色(主色 + 副色, 十六进制) */
    async penLightColors(colorId: number): Promise<string[]> {
        if (!colorId) return [];
        const rows = await masterdataClient.getTable<PenLightColorRow>('MasterLiveMusicPenLightColor').catch(() => []);
        const row = rows.find(r => r.id === colorId);
        if (!row) return [];
        return [row.mainColor, row.sub1Color, row.sub2Color, row.sub3Color, row.sub4Color]
            .filter((c): c is string => !!c && /^#[0-9A-Fa-f]{6}$/.test(c));
    }
}

export const store = new MasterDataStore();
export { t, tSync, preloadText };
