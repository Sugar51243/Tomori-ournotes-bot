import { ensureFuzzyIndex } from './fuzzyIndex';
import { store } from './data/masterdata';
import { fuzzySearch, match, checkRelationList, FuzzySearchResult } from './fuzzySearch';
import { Song } from './types/Song';
import { Card } from './types/Card';
import { SupportCard } from './types/SupportCard';
import { Character } from './types/Character';
import { Gacha } from './types/Gacha';
import { Event } from './types/Event';

/** 按模糊搜索结果过滤歌曲 */
export async function searchSongs(matches: FuzzySearchResult): Promise<Song[]> {
    await store.refresh();
    await ensureFuzzyIndex();
    const rows = await store.songs();
    const songs: Song[] = [];
    for (const row of rows) {
        const song = new Song(row.id);
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
export async function resolveCard(cardId: number, kind: CardKind = 'auto'): Promise<AnyCard | undefined> {
    if (kind !== 'support') {
        const card = new Card(cardId);
        await card.init();
        if (card.isExist) return card;
        if (kind === 'member') return undefined;
    }
    const support = new SupportCard(cardId);
    await support.init();
    return support.isExist ? support : undefined;
}

/** 按模糊搜索结果过滤卡片(默认成员卡+支援卡一起查, 成员卡在前) */
export async function searchCards(matches: FuzzySearchResult, kind: CardKind = 'auto'): Promise<AnyCard[]> {
    await store.refresh();
    await ensureFuzzyIndex();
    const cards: AnyCard[] = [];
    if (kind !== 'support') {
        for (const row of await store.cardList()) {
            const card = new Card(row.id);
            await card.init();
            if (match(matches, card.fuzzyTarget(), [])) cards.push(card);
        }
    }
    if (kind !== 'member') {
        for (const row of await store.supportCardList()) {
            const support = new SupportCard(row.id);
            await support.init();
            if (match(matches, support.fuzzyTarget(), [])) cards.push(support);
        }
    }
    return cards;
}

/** 按模糊搜索结果过滤角色 */
export async function searchCharacters(matches: FuzzySearchResult): Promise<Character[]> {
    await store.refresh();
    await ensureFuzzyIndex();
    const rows = await store.characters();
    const characters: Character[] = [];
    for (const row of rows) {
        const c = new Character(row.id);
        await c.init();
        if (match(matches, c.fuzzyTarget(), [])) {
            characters.push(c);
        }
    }
    return characters;
}

/** 按模糊搜索结果过滤卡池 */
export async function searchGachas(matches: FuzzySearchResult): Promise<Gacha[]> {
    await store.refresh();
    await ensureFuzzyIndex();
    const rows = await store.gachaList();
    const gachas: Gacha[] = [];
    for (const row of rows) {
        const g = new Gacha(row.id);
        await g.init();
        if (match(matches, g.fuzzyTarget(), [])) {
            gachas.push(g);
        }
    }
    return gachas;
}

/** 按模糊搜索结果过滤活动 */
export async function searchEvents(matches: FuzzySearchResult): Promise<Event[]> {
    await store.refresh();
    await ensureFuzzyIndex();
    const rows = await store.eventList();
    const events: Event[] = [];
    for (const row of rows) {
        const e = new Event(row.id);
        await e.init();
        if (match(matches, e.fuzzyTarget(), [])) {
            events.push(e);
        }
    }
    return events;
}

/** text -> 模糊搜索结果 */
export function textToFuzzyResult(text: string): FuzzySearchResult {
    return fuzzySearch(text);
}
