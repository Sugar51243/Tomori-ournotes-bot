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
import {
    bandsOfCharacters, cardKeysOfCharacters, characterIdsOfEvents,
    eventIdsOfCardKeys, eventIdsOfGachaIds, eventIdsOfSongIds,
    gachaIdsOfCardKeys, gachaIdsOfEventIds, songIdsOfEvents, substringIds
} from './searchRelated';

/**
 * 各实体类型的模糊搜索。
 *
 * 搜索优先级固定为 **ID > 自信息 > 关联**, 实现在 resolveXxxMatches 里:
 * - 关键词命中该实体自身的标识键(如歌曲的 songId、角色的 characterId)时, 只按自身标识匹配,
 *   不混入关联维度 —— 已经命中实体本身就不再采用后续搜索结果;
 * - 未命中自身标识时, 才把其它类型的命中翻成关联维度:
 *   乐团/角色(成员关系)、活动(活动曲目/加成角色)、卡池/卡片(UP 卡与活动卡)。
 * - 过滤维度(`_number` / `songLevels` / `_relationStr` / `_all` / `cardType`)在两条路上都保留,
 *   所以 "lv26 MyGO" 这类「筛选项 + 关联实体」的组合查询行为不变。
 *
 * 多命中由调用方出对应种类的列表图, 唯一命中出该端点的单查结果。
 */

type Id = string | number;

/** 各实体自身的标识键: 命中其一即按自信息查询, 不再展开关联维度 */
const IDENTITY_KEYS: Record<string, string[]> = {
    band: ['bandId'],
    song: ['songId'],
    character: ['characterId'],
    card: ['cardId', 'supportCardId'],
    event: ['eventId'],
    gacha: ['gachaId'],
    stamp: ['stampId']
};

/** 过滤维度: 两条搜索路径都保留(数字/等级/关系串/子串回退/卡片属性) */
const FILTER_KEYS = ['_number', 'songLevels', '_relationStr', '_all', 'cardType'];

export function pickKeys(matches: FuzzySearchResult, keys: string[]): FuzzySearchResult {
    const out: FuzzySearchResult = {};
    for (const key of keys) {
        if (matches[key] !== undefined) out[key] = matches[key];
    }
    return out;
}

export function hasKeys(matches: FuzzySearchResult, keys: string[]): boolean {
    return keys.some(key => matches[key] !== undefined);
}

function ids(matches: FuzzySearchResult, key: string): Id[] {
    return (matches[key] ?? []) as Id[];
}

function numIds(matches: FuzzySearchResult, key: string): number[] {
    return ids(matches, key).map(Number).filter(Number.isFinite);
}

function mergeNumbers(a: number[], b: number[]): number[] {
    return [...new Set([...a, ...b])];
}

/** `_all` 里的未解析词(小写): 交给子串回退解析成关联实体 */
export function substringWords(matches: FuzzySearchResult): string[] {
    return ((matches['_all'] ?? []) as Array<string | number>)
        .map(v => String(v).toLowerCase())
        .filter(Boolean);
}

/** 按模糊搜索结果过滤歌曲(全部来自指定区域) */
export async function searchSongs(server: Server, matches: FuzzySearchResult): Promise<Song[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    // 空匹配 = 不过滤(全部歌曲), 供随机歌曲等"无关键词"调用方使用
    const resolved = Object.keys(matches).length === 0 ? {} : await resolveSongMatches(server, matches);
    if (!resolved) return [];
    return filterSongs(server, resolved);
}

/** 自信息 / 关联维度 -> 歌曲的匹配条件 */
async function resolveSongMatches(server: Server, matches: FuzzySearchResult): Promise<FuzzySearchResult | undefined> {
    const out = pickKeys(matches, FILTER_KEYS);
    if (hasKeys(matches, IDENTITY_KEYS.song)) {
        Object.assign(out, pickKeys(matches, IDENTITY_KEYS.song));
        return out;
    }
    // 关联: 乐团(歌曲自带 bandId) / 角色(-> 所属乐团) / 活动(-> 活动曲目)
    // 精确命中(索引键)与子串命中(_all, 如只搜活动名词干)都算
    const words = substringWords(matches);
    const bandIds = mergeNumbers(numIds(matches, 'bandId'), substringIds(server, 'bandId', words));
    if (bandIds.length) out['bandId'] = bandIds;
    const byChars = await bandsOfCharacters(server, mergeNumbers(numIds(matches, 'characterId'), substringIds(server, 'characterId', words)));
    if (byChars.length) out['bandId'] = mergeNumbers((out['bandId'] ?? []) as number[], byChars);
    const byEvents = await songIdsOfEvents(server, mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words)));
    if (byEvents.length) out['songId'] = byEvents;
    return Object.keys(out).length ? out : undefined;
}

async function filterSongs(server: Server, matches: FuzzySearchResult): Promise<Song[]> {
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

    // 自信息: 卡片自身的 ID(两类) / 过滤维度; 关联: 角色/乐团(卡片自带) + 活动/卡池(-> UP 卡与活动卡的键)
    let fuzzy: FuzzySearchResult;
    let relatedKeys: Set<string> | undefined;
    if (hasKeys(matches, IDENTITY_KEYS.card)) {
        fuzzy = { ...pickKeys(matches, FILTER_KEYS), ...pickKeys(matches, IDENTITY_KEYS.card) };
    } else {
        const words = substringWords(matches);
        fuzzy = { ...pickKeys(matches, FILTER_KEYS) };
        const bandIds = mergeNumbers(numIds(matches, 'bandId'), substringIds(server, 'bandId', words));
        const charIds = mergeNumbers(numIds(matches, 'characterId'), substringIds(server, 'characterId', words));
        if (bandIds.length) fuzzy['bandId'] = bandIds;
        if (charIds.length) fuzzy['characterId'] = charIds;
        relatedKeys = await cardKeysFromRelated(server, matches, words);
    }
    // 空匹配 = 不过滤(全部卡片)
    const matchAll = Object.keys(matches).length === 0;
    if (!matchAll && Object.keys(fuzzy).length === 0 && !relatedKeys?.size) return [];

    const store = storeFor(server);
    const cards: AnyCard[] = [];
    if (kind !== 'support') {
        for (const row of await store.cardList()) {
            const card = withServer(new Card(row.id), server);
            await card.init();
            if (relatedKeys?.has(`m:${card.cardId}`) || match(fuzzy, card.fuzzyTarget(), [])) cards.push(card);
        }
    }
    if (kind !== 'member') {
        for (const row of await store.supportCardList()) {
            const support = withServer(new SupportCard(row.id), server);
            await support.init();
            if (relatedKeys?.has(`s:${support.supportCardId}`) || match(fuzzy, support.fuzzyTarget(), [])) cards.push(support);
        }
    }
    return cards;
}

/** 活动/卡池的命中(含 `_all` 子串命中) -> 其相关卡片的键(m:<id> / s:<id>) */
async function cardKeysFromRelated(server: Server, matches: FuzzySearchResult, words: string[]): Promise<Set<string>> {
    const index = await storeFor(server).relatedIndex();
    const keys = new Set<string>();
    const eventIds = mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words));
    for (const id of eventIds) {
        for (const key of index.cardKeysByEvent.get(id) ?? []) keys.add(key);
    }
    const gachaIds = mergeNumbers(numIds(matches, 'gachaId'), substringIds(server, 'gachaId', words));
    for (const id of gachaIds) {
        for (const key of index.upCardKeysByGacha.get(id) ?? []) keys.add(key);
    }
    return keys;
}

/** 按模糊搜索结果过滤角色 */
export async function searchCharacters(server: Server, matches: FuzzySearchResult): Promise<Character[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);

    // 自信息: characterId; 关联: 乐团(角色自带 bandId) + 活动(-> 该活动的加成/相关角色)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, IDENTITY_KEYS.character)) {
        fuzzy = { ...pickKeys(matches, FILTER_KEYS), ...pickKeys(matches, IDENTITY_KEYS.character) };
    } else {
        const words = substringWords(matches);
        fuzzy = { ...pickKeys(matches, FILTER_KEYS) };
        const bandIds = mergeNumbers(numIds(matches, 'bandId'), substringIds(server, 'bandId', words));
        if (bandIds.length) fuzzy['bandId'] = bandIds;
        const byEvents = await characterIdsOfEvents(server, mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words)));
        if (byEvents.length) fuzzy['characterId'] = byEvents;
    }
    // 空匹配 = 不过滤(全部角色)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const rows = await storeFor(server).characters();
    const characters: Character[] = [];
    for (const row of rows) {
        const c = withServer(new Character(row.id), server);
        await c.init();
        if (match(fuzzy, c.fuzzyTarget(), [])) {
            characters.push(c);
        }
    }
    return characters;
}

/** 按模糊搜索结果过滤乐团(名称/别名 + 自定义关键词) */
export async function searchBands(server: Server, matches: FuzzySearchResult): Promise<Band[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);

    // 自信息: bandId; 关联: 角色(-> 该角色的所属乐团)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, IDENTITY_KEYS.band)) {
        fuzzy = { ...pickKeys(matches, FILTER_KEYS), ...pickKeys(matches, IDENTITY_KEYS.band) };
    } else {
        fuzzy = pickKeys(matches, FILTER_KEYS);
        const words = substringWords(matches);
        const bands = await bandsOfCharacters(server, mergeNumbers(numIds(matches, 'characterId'), substringIds(server, 'characterId', words)));
        if (bands.length) fuzzy['bandId'] = bands;
    }
    // 空匹配 = 不过滤(全部乐团)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const rows = await storeFor(server).bandList();
    const bands: Band[] = [];
    for (const row of rows) {
        const band = withServer(new Band(row.id), server);
        await band.init();
        if (match(fuzzy, band.fuzzyTarget(), [])) {
            bands.push(band);
        }
    }
    return bands;
}

/** 按模糊搜索结果过滤卡池 */
export async function searchGachas(server: Server, matches: FuzzySearchResult): Promise<Gacha[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);

    // 自信息: gachaId; 关联: 卡片(-> 该卡作为 UP 的卡池) / 角色/乐团(-> 其卡片 -> 卡池) / 活动(启发式)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, IDENTITY_KEYS.gacha)) {
        fuzzy = { ...pickKeys(matches, FILTER_KEYS), ...pickKeys(matches, IDENTITY_KEYS.gacha) };
    } else {
        fuzzy = pickKeys(matches, FILTER_KEYS);
        const words = substringWords(matches);
        const gachaIds = new Set<number>();
        const cardKeys = [
            ...numIds(matches, 'cardId').map(id => `m:${id}`),
            ...numIds(matches, 'supportCardId').map(id => `s:${id}`),
            ...substringIds(server, 'cardId', words).map(id => `m:${id}`),
            ...substringIds(server, 'supportCardId', words).map(id => `s:${id}`),
            ...await cardKeysOfCharacters(
                server,
                mergeNumbers(numIds(matches, 'characterId'), substringIds(server, 'characterId', words)),
                mergeNumbers(numIds(matches, 'bandId'), substringIds(server, 'bandId', words))
            )
        ];
        for (const id of await gachaIdsOfCardKeys(server, cardKeys)) gachaIds.add(id);
        for (const id of await gachaIdsOfEventIds(server, mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words)))) gachaIds.add(id);
        if (gachaIds.size) fuzzy['gachaId'] = [...gachaIds];
    }
    // 空匹配 = 不过滤(全部卡池)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const rows = await storeFor(server).gachaList();
    const gachas: Gacha[] = [];
    for (const row of rows) {
        const g = withServer(new Gacha(row.id), server);
        await g.init();
        if (match(fuzzy, g.fuzzyTarget(), [])) {
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

/** 自信息 / 关联维度 -> 活动的匹配条件 */
async function resolveEventMatches(server: Server, rest: FuzzySearchResult): Promise<FuzzySearchResult | undefined> {
    const out = pickKeys(rest, FILTER_KEYS);
    if (hasKeys(rest, IDENTITY_KEYS.event)) {
        Object.assign(out, pickKeys(rest, IDENTITY_KEYS.event));
        return out;
    }
    // 关联: 乐团/角色(活动的加成字段, 直接 match) + 卡池/卡片/歌曲(-> 相关活动 id)
    // 精确命中(索引键)与子串命中(_all)都算
    const words = substringWords(rest);
    const bandIds = mergeNumbers(numIds(rest, 'bandId'), substringIds(server, 'bandId', words));
    const charIds = mergeNumbers(numIds(rest, 'characterId'), substringIds(server, 'characterId', words));
    if (bandIds.length) out['bandId'] = bandIds;
    if (charIds.length) out['characterId'] = charIds;
    const related = new Set<number>([
        ...await eventIdsOfGachaIds(server, mergeNumbers(numIds(rest, 'gachaId'), substringIds(server, 'gachaId', words))),
        ...await eventIdsOfCardKeys(server, [
            ...numIds(rest, 'cardId').map(id => `m:${id}`),
            ...numIds(rest, 'supportCardId').map(id => `s:${id}`),
            ...substringIds(server, 'cardId', words).map(id => `m:${id}`),
            ...substringIds(server, 'supportCardId', words).map(id => `s:${id}`)
        ]),
        ...await eventIdsOfSongIds(server, mergeNumbers(numIds(rest, 'songId'), substringIds(server, 'songId', words)))
    ]);
    if (related.size) out['eventId'] = [...related];
    return Object.keys(out).length ? out : undefined;
}

/** 按模糊搜索结果过滤活动(名称/角色/乐队/属性 + 时间维度) */
export async function searchEvents(server: Server, matches: FuzzySearchResult): Promise<Event[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const { rest, statuses, dates } = splitEventKeywords(matches);
    const now = new Date();

    // 关键词里除了状态/日期没有别的 -> 不做名称匹配, 直接按状态/日期筛
    const onlyTimeFilters = Object.keys(rest).length === 0;
    const resolved = await resolveEventMatches(server, rest);
    // 有关键词但没有可用维度(如命中的是贴纸) -> 不返回任何活动
    if (!onlyTimeFilters && !resolved) return [];

    const rows = await storeFor(server).eventList();
    const events: Event[] = [];
    for (const row of rows) {
        const e = withServer(new Event(row.id), server);
        await e.init();
        if (!onlyTimeFilters && !match(resolved!, e.fuzzyTarget(), [])) continue;
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
