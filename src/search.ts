import { ensureFuzzyIndex } from './fuzzyIndex';
import { refreshRegion, storeFor } from './data/region';
import { fuzzySearch, match, checkRelationList, FuzzySearchResult } from './fuzzySearch';
import { Server, withServer } from './types/Server';
import { Song } from './types/Song';
import { Card } from './types/Card';
import { SupportCard } from './types/SupportCard';
import { Character } from './types/Character';
import { Band } from './types/Band';
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
/** 按模糊搜索结果过滤乐团(名称/别名 + 自定义关键词) */
export async function searchBands(server: Server, matches: FuzzySearchResult): Promise<Band[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const rows = await storeFor(server).bandList();
    const bands: Band[] = [];
    for (const row of rows) {
        const band = withServer(new Band(row.id), server);
        await band.init();
        if (match(matches, band.fuzzyTarget(), [])) {
            bands.push(band);
        }
    }
    return bands;
}

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

/**
 * 活动的「时间」搜索维度: 状态关键词。
 * 关键词落到 matches._all 里时, 先看是不是状态词, 是就从匹配里摘出来改成状态过滤,
 * 剩下的词才交给 match() 做名称/角色/乐队/属性匹配。
 */
const STATUS_KEYWORDS: Array<{ words: string[]; test: (e: Event, now: Date) => boolean }> = [
    { words: ['进行中', '开启中', '开放中', 'ongoing'], test: (e, now) => e.status(now) === 'open' },
    { words: ['即将结束', '快结束', '将要结束'], test: (e, now) => e.status(now) === 'open' && !!e.endAt && e.endAt.getTime() - now.getTime() < 24 * 3600 * 1000 },
    { words: ['未开始', '未开', '即将开始', '尚未开始'], test: (e, now) => e.status(now) === 'upcoming' },
    { words: ['已结束', '结束', '已关闭'], test: (e, now) => e.status(now) === 'ended' }
];

/** 从关键词里摘出状态词与日期串; 返回剩余关键词(交给 match)与筛选条件 */
function splitEventKeywords(matches: FuzzySearchResult): {
    rest: FuzzySearchResult;
    statuses: Array<(e: Event, now: Date) => boolean>;
    dates: string[];
} {
    const statuses: Array<(e: Event, now: Date) => boolean> = [];
    const dates: string[] = [];
    const words = ((matches['_all'] ?? []) as Array<string | number>).map(String);
    const kept: string[] = [];
    for (const word of words) {
        const hit = STATUS_KEYWORDS.find(s => s.words.some(w => word.includes(w)));
        if (hit) {
            statuses.push(hit.test);
            continue;
        }
        // 日期串形如 2026/09/30 或 2026-09-30
        if (/^\d{4}[\/\-]\d{1,2}([\/\-]\d{1,2})?$/.test(word)) {
            dates.push(word.replace(/-/g, '/'));
            continue;
        }
        kept.push(word);
    }
    const rest: FuzzySearchResult = { ...matches };
    if (kept.length) rest['_all'] = kept;
    else delete rest['_all'];
    return { rest, statuses, dates };
}

/** 按模糊搜索结果过滤活动(名称/角色/乐队/属性 + 时间维度) */
export async function searchEvents(server: Server, matches: FuzzySearchResult): Promise<Event[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const { rest, statuses, dates } = splitEventKeywords(matches);
    const now = new Date();

    // 关键词里除了状态/日期没有别的 -> 不做名称匹配, 直接按状态/日期筛
    const onlyTimeFilters = Object.keys(rest).length === 0;

    const rows = await storeFor(server).eventList();
    const events: Event[] = [];
    for (const row of rows) {
        const e = withServer(new Event(row.id), server);
        await e.init();
        if (!onlyTimeFilters && !match(rest, e.fuzzyTarget(), [])) continue;
        if (!statuses.every(t => t(e, now))) continue;
        if (dates.length) {
            // 日期串与开放/结束时间做子串匹配(已把 - 统一成 /)
            const range = `${formatRange(e)}`;
            if (!dates.some(d => range.includes(d))) continue;
        }
        events.push(e);
    }
    return events;
}

/** 活动的起止时间文本(与图片上显示的口径一致), 供日期搜索使用 */
function formatRange(e: Event): string {
    const fmt = (d?: Date) => {
        if (!d) return '';
        return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    };
    return `${fmt(e.startAt)} ${fmt(e.endAt)}`;
}

/**
 * text -> 模糊搜索结果(按区域分片的索引)。
 *
 * 必须**先确保索引已装载**再解析: 索引未装载时所有词都会落到 `_all` 子串回退,
 * 用户关键词解析不成实体 id, 搜索就会莫名其妙地搜不到。
 * 因此这个函数是 async 的, 调用方一律 await(内部 ensureFuzzyIndex 有磁盘缓存, 代价很低)。
 */
export async function textToFuzzyResult(server: Server, text: string): Promise<FuzzySearchResult> {
    await ensureFuzzyIndex(server);
    return fuzzySearch(server, text);
}
