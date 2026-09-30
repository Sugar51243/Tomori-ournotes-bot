import { ensureFuzzyIndex } from './fuzzyIndex';
import { refreshRegion, storeFor } from './data/region';
import { fuzzySearch, match, checkRelationList, FuzzySearchResult } from './fuzzySearch';
import { Server, withServer } from './types/Server';
import { Song } from './types/Song';
import { Card } from './types/Card';
import { SupportCard } from './types/SupportCard';
import { Character } from './types/Character';
import { Gacha } from './types/Gacha';
import { Event } from './types/Event';

/** 按模糊搜索结果过滤歌曲(全部来自指定区域) */
export async function searchSongs(server: Server, matches: FuzzySearchResult): Promise<Song[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const store = storeFor(server);
    const rows = await store.songs();
    const songs: Song[] = [];
    for (const row of rows) {
        const song = withServer(new Song(row.id), server);
        await song.init();
        if (match(matches, song.fuzzyTarget(), ['songLevels'])) {
            songs.push(song);
        }
    }
    if (matches['_relationStr'] && matches['_relationStr'].length > 0) {
        return songs.filter(s => checkRelationList(s.songId, matches['_relationStr'] as string[]));
    }
    return songs;
}

/** 卡片类型: 成员卡(角色卡) / 支援卡; auto 表示两者都查 */
export type CardKind = 'member' | 'support' | 'auto';

/** 成员卡与支援卡的联合类型 */
export type AnyCard = Card | SupportCard;

export function isMemberCard(card: AnyCard): card is Card {
    return (card as Card).cardId !== undefined;
}

/**
 * 按 ID 解析卡片(成员卡与支援卡 ID 空间重叠, 故需类型判别):
 * - kind='auto': 先按成员卡查, 未命中再按支援卡查
 */
export async function resolveCard(server: Server, cardId: number, kind: CardKind = 'auto'): Promise<AnyCard | undefined> {
    if (kind !== 'support') {
        const card = withServer(new Card(cardId), server);
        await card.init();
        if (card.isExist) return card;
        if (kind === 'member') return undefined;
    }
    const support = withServer(new SupportCard(cardId), server);
    await support.init();
    return support.isExist ? support : undefined;
}

/** 按模糊搜索结果过滤卡片(默认成员卡+支援卡一起查, 成员卡在前) */
export async function searchCards(server: Server, matches: FuzzySearchResult, kind: CardKind = 'auto'): Promise<AnyCard[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const store = storeFor(server);
    const cards: AnyCard[] = [];
    if (kind !== 'support') {
        for (const row of await store.cardList()) {
            const card = withServer(new Card(row.id), server);
            await card.init();
            if (match(matches, card.fuzzyTarget(), [])) cards.push(card);
        }
    }
    if (kind !== 'member') {
        for (const row of await store.supportCardList()) {
            const support = withServer(new SupportCard(row.id), server);
            await support.init();
            if (match(matches, support.fuzzyTarget(), [])) cards.push(support);
        }
    }
    return cards;
}

/** 按模糊搜索结果过滤角色 */
export async function searchCharacters(server: Server, matches: FuzzySearchResult): Promise<Character[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const rows = await storeFor(server).characters();
    const characters: Character[] = [];
    for (const row of rows) {
        const c = withServer(new Character(row.id), server);
        await c.init();
        if (match(matches, c.fuzzyTarget(), [])) {
            characters.push(c);
        }
    }
    return characters;
}

/** 按模糊搜索结果过滤卡池 */
export async function searchGachas(server: Server, matches: FuzzySearchResult): Promise<Gacha[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const rows = await storeFor(server).gachaList();
    const gachas: Gacha[] = [];
    for (const row of rows) {
        const g = withServer(new Gacha(row.id), server);
        await g.init();
        if (match(matches, g.fuzzyTarget(), [])) {
            gachas.push(g);
        }
    }
    return gachas;
}

/** 按模糊搜索结果过滤活动 */
export async function searchEvents(server: Server, matches: FuzzySearchResult): Promise<Event[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const rows = await storeFor(server).eventList();
    const events: Event[] = [];
    for (const row of rows) {
        const e = withServer(new Event(row.id), server);
        await e.init();
        if (match(matches, e.fuzzyTarget(), [])) {
            events.push(e);
        }
    }
    return events;
}

/** text -> 模糊搜索结果(按区域分片的索引) */
export function textToFuzzyResult(server: Server, text: string): FuzzySearchResult {
    return fuzzySearch(server, text);
}
