import { ensureFuzzyIndex } from './fuzzyIndex';
import { refreshRegion, storeFor } from '../db/adapter';
import { fuzzySearch, match, checkRelationList, targetHasSubstring, FuzzySearchResult } from './fuzzySearch';
import { Server, serverProfile, withServer } from '../features/types/Server';
import { Song } from '../features/types/Song';
import { Card } from '../features/types/Card';
import { SupportCard } from '../features/types/SupportCard';
import { Character } from '../features/types/Character';
import { Band } from '../features/types/Band';
import { Gacha } from '../features/types/Gacha';
import { Event } from '../features/types/Event';
import {
    bandsOfCharacters, cardKeysOfCharacters, characterIdsOfEvents,
    eventIdsOfCardKeys, eventIdsOfGachaIds, eventIdsOfSongIds,
    gachaIdsOfCardKeys, gachaIdsOfEventIds, songIdsOfEvents, substringIds, substringMatch
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

/** 从匹配条件里挑出指定键的子集(不含的键丢弃) */
export function pickKeys(matches: FuzzySearchResult, keys: string[]): FuzzySearchResult {
    const out: FuzzySearchResult = {};
    for (const key of keys) {
        if (matches[key] !== undefined) out[key] = matches[key];
    }
    return out;
}

/** 匹配条件里是否出现指定键中的任意一个 */
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

/**
 * 关联维度解析的记账本: 记录"已经被用来命中**实体自身字段**的词"。
 * 这些词不该再当子串约束 —— 「mujica」解析成乐团(28 张卡)才是用户的意思,
 * 但它恰好也出现在 2 张卡的名字里, 不消费掉就会把结果缩成那 2 张。
 *
 * 只对**自身字段**消费(bandId/characterId 之于卡片、bandId 之于歌曲…):
 * 那些维度的条件已经由 typed key 把关, 再要求子串就是重复计算。
 * 转蛋/活动这类**关联**维度不消费 —— 否则「ssr」会被某个叫「SSR 確定」的转蛋名消化掉,
 * 用户要的"稀有度 SSR"这个约束就丢了。
 */
function makeWordLedger(server: Server): {
    ids: (type: string, words: string[]) => number[];
    unused: (words: string[]) => string[];
    strip: (out: FuzzySearchResult) => FuzzySearchResult;
} {
    const used = new Set<string>();
    return {
        ids(type, words) {
            if (!words.length) return [];
            const m = substringMatch(server, type, words);
            m.used.forEach(w => used.add(w));
            return m.ids;
        },
        /** 还没被任何自身维度解释过的词 —— 只有这些才该继续去解析关联维度 */
        unused(words) {
            return words.filter(w => !used.has(w.toLowerCase()));
        },
        strip(out) {
            if (!used.size || out['_all'] === undefined) return out;
            const rest = (out['_all'] as Array<string | number>).filter(w => !used.has(String(w).toLowerCase()));
            if (rest.length) out['_all'] = rest;
            else delete out['_all'];
            return out;
        }
    };
}

/**
 * `_all` 的"宽容 AND": 多参数查询里索引没解析成实体的词, 该怎么参与过滤。
 * - 在**全部候选中都找不到**的词 = 错别字/噪声 -> 从约束里剔掉, 免得把一个本来有效的结果清空;
 * - 剩下有命中的词 -> 每个都必须在实体自己的字段里出现(由 match() 做 AND)。
 * 例: `MyGO ssr` = MyGO ∩ SSR;`MyGO zzz` = MyGO(zzz 谁都命中不了, 忽略)。
 * @param targets 该端点**全部**候选的 fuzzyTarget(先于其它过滤条件, 保证"有命中"是全局判断)
 * @returns 改写后的 matches;`undefined` = 词全死光且再无其它约束 —— 再往下就退化成"不过滤"
 *          (把整张表倒出来), 调用方应直接返回空。
 */
function pruneDeadWords(matches: FuzzySearchResult, targets: Array<Record<string, unknown>>): FuzzySearchResult | undefined {
    const words = matches['_all'] as Array<string | number> | undefined;
    if (!words || words.length === 0) return matches;
    const live = words.filter(w => {
        const word = String(w).toLowerCase();
        return targets.some(t => targetHasSubstring(t, word));
    });
    if (live.length === words.length) return matches;
    const out: FuzzySearchResult = { ...matches };
    if (live.length) {
        out['_all'] = live;
        return out;
    }
    delete out['_all'];
    // 只剩 _number / _relationStr 也算"还有约束"(前者在 match 里不通过, 后者由范围过滤处理)
    return Object.keys(out).length ? out : undefined;
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
        // ID 命中时其余维度一并保留(多参数 AND); 目标没有的键由 match() 忽略
        return { ...matches };
    }
    // 关联: 乐团(歌曲自带 bandId) / 角色(-> 所属乐团) / 活动(-> 活动曲目)
    // 精确命中(索引键)与子串命中(_all, 如只搜活动名词干)都算
    const words = substringWords(matches);
    const ledger = makeWordLedger(server);
    const bandIds = mergeNumbers(numIds(matches, 'bandId'), ledger.ids('bandId', words));
    if (bandIds.length) out['bandId'] = bandIds;
    const byChars = await bandsOfCharacters(server, mergeNumbers(numIds(matches, 'characterId'), ledger.ids('characterId', words)));
    if (byChars.length) out['bandId'] = mergeNumbers((out['bandId'] ?? []) as number[], byChars);
    // 活动 -> 曲目是**关联**映射(歌曲自身没有活动字段), 这类词不消费
    const byEvents = await songIdsOfEvents(server, mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words)));
    if (byEvents.length) out['songId'] = byEvents;
    ledger.strip(out);
    return Object.keys(out).length ? out : undefined;
}

async function filterSongs(server: Server, matches: FuzzySearchResult): Promise<Song[]> {
    const store = storeFor(server);
    const rows = await store.songs();
    // 先建好候选与各自的 fuzzyTarget: "死词剔除"与正式过滤共用同一份, init 仍只做一次
    const candidates: Array<{ song: Song; target: Record<string, unknown> }> = [];
    for (const row of rows) {
        const song = withServer(new Song(row.id), server);
        await song.init();
        candidates.push({ song, target: song.fuzzyTarget() });
    }
    const effective = pruneDeadWords(matches, candidates.map(c => c.target));
    if (!effective) return [];
    const songs = candidates.filter(c => match(effective, c.target, ['songLevels'])).map(c => c.song);
    if (effective['_relationStr'] && effective['_relationStr'].length > 0) {
        return songs.filter(s => checkRelationList(s.songId, effective['_relationStr'] as string[]));
    }
    return songs;
}

/** 卡片类型: 成员卡(角色卡) / 支援卡; auto 表示两者都查 */
export type CardKind = 'member' | 'support' | 'auto';

/** 成员卡与支援卡的联合类型 */
export type AnyCard = Card | SupportCard;

/** 类型收窄: 判断一张卡是成员卡(角色卡)还是支援卡 */
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
    // 命中 ID 与否都做同一套解析 —— 多参数要一并生效(「mujica 4星」= 该团 ∩ 4 星,
    // 命中「4星」不代表可以把「mujica」丢掉);目标没有的键由 match() 忽略。
    const words = substringWords(matches);
    const ledger = makeWordLedger(server);
    const fuzzy: FuzzySearchResult = { ...matches };
    const bandIds = mergeNumbers(numIds(matches, 'bandId'), ledger.ids('bandId', words));
    const charIds = mergeNumbers(numIds(matches, 'characterId'), ledger.ids('characterId', words));
    if (bandIds.length) fuzzy['bandId'] = bandIds;
    if (charIds.length) fuzzy['characterId'] = charIds;
    // 关联维度只用"还没被自身维度解释过"的词: 「mujica」已解析成乐团, 就不该再去翻
    // 「叫 mujica 的转蛋」;剩下的词(如活动名)才走活动/卡池 -> 卡片
    const leftover = ledger.unused(words);
    const relatedKeys = leftover.length ? await cardKeysFromRelated(server, matches, leftover) : undefined;
    ledger.strip(fuzzy);
    // 空匹配 = 不过滤(全部卡片)
    const matchAll = Object.keys(matches).length === 0;
    if (!matchAll && Object.keys(fuzzy).length === 0 && !relatedKeys?.size) return [];

    const store = storeFor(server);
    // 两类卡一起收集后再过滤: "死词剔除"要在成员卡+支援卡的全集上判断
    const candidates: Array<{ card: AnyCard; target: Record<string, unknown> }> = [];
    if (kind !== 'support') {
        for (const row of await store.cardList()) {
            const card = withServer(new Card(row.id), server);
            await card.init();
            candidates.push({ card, target: card.fuzzyTarget() });
        }
    }
    if (kind !== 'member') {
        for (const row of await store.supportCardList()) {
            const support = withServer(new SupportCard(row.id), server);
            await support.init();
            candidates.push({ card: support, target: support.fuzzyTarget() });
        }
    }
    // 词全死光时: 还有关联命中就按关联出结果(死词当作噪声), 否则返回空
    const effective = pruneDeadWords(fuzzy, candidates.map(c => c.target)) ?? (relatedKeys?.size ? {} : undefined);
    if (!effective) return [];
    // 未消费的 `_all` 词是"额外参数", 所有结果都要满足(AND); 关联命中(活动/卡池 -> 卡)
    // 与自身维度一样是硬条件 —— 参数之间是 AND, 只有同一批词的多种解释才取并(已在上面的
    // "已消费的词不再解析关联"里处理掉)。
    const { _all: residual, ...base } = effective;
    const residualWords = ((residual ?? []) as Array<string | number>).map(w => String(w).toLowerCase());
    const cards: AnyCard[] = [];
    for (const { card, target } of candidates) {
        const key = isMemberCard(card) ? `m:${card.cardId}` : `s:${(card as SupportCard).supportCardId}`;
        if (relatedKeys?.size && !relatedKeys.has(key)) continue;
        if (!match(base, target, [])) continue;
        if (residualWords.length && !residualWords.every(w => targetHasSubstring(target, w))) continue;
        cards.push(card);
    }
    return cards;
}

/** 活动/卡池的命中(含 `_all` 子串命中) -> 其相关卡片的键(m:<id> / s:<id>) */
async function cardKeysFromRelated(server: Server, matches: FuzzySearchResult, words: string[]): Promise<Set<string>> {
    const index = await storeFor(server).relatedIndex();
    const keys = new Set<string>();
    // 活动/卡池 -> 卡片是关联映射(卡片自身没有这些字段), 不消费词
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
        // ID 命中时其余维度一并保留(多参数 AND); 目标没有的键由 match() 忽略
        fuzzy = { ...matches };
    } else {
        const words = substringWords(matches);
        const ledger = makeWordLedger(server);
        fuzzy = { ...pickKeys(matches, FILTER_KEYS) };
        const bandIds = mergeNumbers(numIds(matches, 'bandId'), ledger.ids('bandId', words));
        if (bandIds.length) fuzzy['bandId'] = bandIds;
        // 活动 -> 角色是关联映射(角色自身没有活动字段), 不消费词
        const byEvents = await characterIdsOfEvents(server, mergeNumbers(numIds(matches, 'eventId'), substringIds(server, 'eventId', words)));
        if (byEvents.length) fuzzy['characterId'] = byEvents;
        ledger.strip(fuzzy);
    }
    // 空匹配 = 不过滤(全部角色)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const rows = await storeFor(server).characters();
    const candidates: Array<{ character: Character; target: Record<string, unknown> }> = [];
    for (const row of rows) {
        const c = withServer(new Character(row.id), server);
        await c.init();
        candidates.push({ character: c, target: c.fuzzyTarget() });
    }
    const effective = pruneDeadWords(fuzzy, candidates.map(c => c.target));
    if (!effective) return [];
    return candidates.filter(c => match(effective, c.target, [])).map(c => c.character);
}

/** 按模糊搜索结果过滤乐团(名称/别名 + 自定义关键词) */
export async function searchBands(server: Server, matches: FuzzySearchResult): Promise<Band[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);

    // 自信息: bandId; 关联: 角色(-> 该角色的所属乐团)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, IDENTITY_KEYS.band)) {
        // ID 命中时其余维度一并保留(多参数 AND); 目标没有的键由 match() 忽略
        fuzzy = { ...matches };
    } else {
        fuzzy = pickKeys(matches, FILTER_KEYS);
        const words = substringWords(matches);
        // 角色 -> 乐团是关联映射(乐团自身没有角色字段), 不消费词
        const bands = await bandsOfCharacters(server, mergeNumbers(numIds(matches, 'characterId'), substringIds(server, 'characterId', words)));
        if (bands.length) fuzzy['bandId'] = bands;
    }
    // 空匹配 = 不过滤(全部乐团)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const rows = await storeFor(server).bandList();
    const candidates: Array<{ band: Band; target: Record<string, unknown> }> = [];
    for (const row of rows) {
        const band = withServer(new Band(row.id), server);
        await band.init();
        candidates.push({ band, target: band.fuzzyTarget() });
    }
    const effective = pruneDeadWords(fuzzy, candidates.map(c => c.target));
    if (!effective) return [];
    return candidates.filter(c => match(effective, c.target, [])).map(c => c.band);
}

/** 按模糊搜索结果过滤卡池 */
export async function searchGachas(server: Server, matches: FuzzySearchResult): Promise<Gacha[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);

    // 自信息: gachaId; 关联: 卡片(-> 该卡作为 UP 的卡池) / 角色/乐团(-> 其卡片 -> 卡池) / 活动(启发式)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, IDENTITY_KEYS.gacha)) {
        // ID 命中时其余维度一并保留(多参数 AND); 目标没有的键由 match() 忽略
        fuzzy = { ...matches };
    } else {
        fuzzy = pickKeys(matches, FILTER_KEYS);
        const words = substringWords(matches);
        // 卡片/角色/乐团/活动 -> 卡池全是关联映射(卡池自身只有名字), 不消费词
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
    const candidates: Array<{ gacha: Gacha; target: Record<string, unknown> }> = [];
    for (const row of rows) {
        const g = withServer(new Gacha(row.id), server);
        await g.init();
        candidates.push({ gacha: g, target: g.fuzzyTarget() });
    }
    const effective = pruneDeadWords(fuzzy, candidates.map(c => c.target));
    if (!effective) return [];
    return candidates.filter(c => match(effective, c.target, [])).map(c => c.gacha);
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

/** 日期形词的提取正则: 年月日(两种顺序) + 斜杠月份(两种顺序); 横杠的年-月已被 fuzzySearch 交给这里 */
const DATE_TOKEN_RE = /^\d{4}[\/\-]\d{1,2}([\/\-]\d{1,2})?$|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$|^\d{1,2}\/\d{4}$/;

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
        // 日期串(原样保留, 解析放在 searchEvents 里按服务器时区进行)
        if (DATE_TOKEN_RE.test(word)) {
            dates.push(word);
            continue;
        }
        kept.push(word);
    }
    const rest: FuzzySearchResult = { ...matches };
    if (kept.length) rest['_all'] = kept;
    else delete rest['_all'];
    return { rest, statuses, dates };
}

/**
 * 把用户输入的日期串解析成该服务器时区内的 [起, 止) 时间窗。
 *
 * 支持: 2026-9-30 / 30-9-2026 / 2026/9/30 / 9/30/2026(零填充同样支持),
 * 以及月份 2026/9、9/2026(斜杠形式; 横杠的 9-2026 会与歌曲 ID 区间冲突, 不在此列)。
 * 年份在尾的三段式会按「日-月」与「月-日」两种读法都试一遍, **恰好一种合法才接受**
 * (如 1-2-2026 两种都合法, 属二义拒绝)。分隔符在一串内必须一致; 非法日期(如 2026-2-30)拒绝。
 *
 * @param word 日期形词(由 splitEventKeywords 提取)
 * @param server 按该服的墙钟时间理解输入 —— 与活动起止时间的解析口径一致
 * @returns 解析出的 [起, 止) 时间窗; 无法解析/二义返回 undefined
 */
export function parseSearchDateWindow(word: string, server: Server): { start: Date; end: Date } | undefined {
    const sep = word.includes('/') ? '/' : '-';
    const parts = word.split(sep);
    if (!parts.every(p => /^\d{1,4}$/.test(p))) return undefined;

    const offsetMs = serverProfile(server).utcOffsetMinutes * 60_000;
    /** 某年月日是否真实存在(Date.UTC 会把 2026-2-30 进位成 3 月, 用分量比对拒绝) */
    const valid = (year: number, month: number, day: number): Date | undefined => {
        if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
        const utc = new Date(Date.UTC(year, month - 1, day));
        if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return undefined;
        return new Date(utc.getTime() - offsetMs);
    };
    /** 日窗口(起点已换算到服务器时区) */
    const dayWindow = (start: Date): { start: Date; end: Date } => ({ start, end: new Date(start.getTime() + 86400_000) });

    if (parts.length === 2) {
        // 月份形式只认斜杠(YYYY/M 或 M/YYYY): 横杠的 9-2026 是合法的歌曲 ID 区间, 不在此列
        if (sep !== '/') return undefined;
        const year = parts[0].length === 4 ? +parts[0] : parts[1].length === 4 ? +parts[1] : NaN;
        const month = parts[0].length === 4 ? +parts[1] : parts[1].length === 4 ? +parts[0] : NaN;
        if (!Number.isFinite(year) || month < 1 || month > 12) return undefined;
        return { start: new Date(Date.UTC(year, month - 1, 1) - offsetMs), end: new Date(Date.UTC(year, month, 1) - offsetMs) };
    }

    if (parts.length === 3) {
        const year = parts[0].length === 4 ? +parts[0] : parts[2].length === 4 ? +parts[2] : NaN;
        if (!Number.isFinite(year)) return undefined;
        if (parts[0].length === 4) {
            // 年-月-日: 唯一读法
            const start = valid(year, +parts[1], +parts[2]);
            return start ? dayWindow(start) : undefined;
        }
        // 年份在尾: 日-月 与 月-日 两种读法都试, 恰好一种合法才接受
        const a = +parts[0];
        const b = +parts[1];
        const asDayFirst = valid(year, b, a);
        const asMonthFirst = valid(year, a, b);
        if (asDayFirst && !asMonthFirst) return dayWindow(asDayFirst);
        if (!asDayFirst && asMonthFirst) return dayWindow(asMonthFirst);
        return undefined;
    }

    return undefined;
}

/** 活动时间区间与日期窗口是否重叠(缺边的时间用另一边代替, 与旧子串行为对单边活动一致) */
function eventOverlapsWindow(e: Event, w: { start: Date; end: Date }): boolean {
    const from = (e.startAt ?? e.endAt)?.getTime();
    const to = (e.endAt ?? e.startAt)?.getTime();
    if (from === undefined || to === undefined) return false;
    return from < w.end.getTime() && to >= w.start.getTime();
}

/** 自信息 / 关联维度 -> 活动的匹配条件 */
async function resolveEventMatches(server: Server, rest: FuzzySearchResult): Promise<FuzzySearchResult | undefined> {
    const out = pickKeys(rest, FILTER_KEYS);
    if (hasKeys(rest, IDENTITY_KEYS.event)) {
        // ID 命中时其余维度一并保留(多参数 AND); 目标没有的键由 match() 忽略
        return { ...rest };
    }
    // 关联: 乐团/角色(活动的加成字段, 直接 match) + 卡池/卡片/歌曲(-> 相关活动 id)
    // 精确命中(索引键)与子串命中(_all)都算
    const words = substringWords(rest);
    const ledger = makeWordLedger(server);
    const bandIds = mergeNumbers(numIds(rest, 'bandId'), ledger.ids('bandId', words));
    const charIds = mergeNumbers(numIds(rest, 'characterId'), ledger.ids('characterId', words));
    if (bandIds.length) out['bandId'] = bandIds;
    if (charIds.length) out['characterId'] = charIds;
    // 卡池/卡片/歌曲 -> 活动是关联映射(活动自身没有这些字段), 不消费词
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
    ledger.strip(out);
    return Object.keys(out).length ? out : undefined;
}

/** 按模糊搜索结果过滤活动(名称/角色/乐队/属性 + 时间维度) */
export async function searchEvents(server: Server, matches: FuzzySearchResult): Promise<Event[]> {
    await refreshRegion(server);
    await ensureFuzzyIndex(server);
    const { rest, statuses, dates } = splitEventKeywords(matches);
    const now = new Date();

    // 日期形词解析成时间窗(在该服时区内); 出现日期形词但全部非法(如 2026-2-30) -> 空结果, 不放行全部活动
    const windows = dates
        .map(d => parseSearchDateWindow(d, server))
        .filter((w): w is { start: Date; end: Date } => w !== undefined);
    if (dates.length && !windows.length) return [];

    // 关键词里除了状态/日期没有别的 -> 不做名称匹配, 直接按状态/日期筛
    const onlyTimeFilters = Object.keys(rest).length === 0;
    const resolved = await resolveEventMatches(server, rest);
    // 有关键词但没有可用维度(如命中的是贴纸) -> 不返回任何活动
    if (!onlyTimeFilters && !resolved) return [];

    const rows = await storeFor(server).eventList();
    const candidates: Array<{ event: Event; target: Record<string, unknown> }> = [];
    for (const row of rows) {
        const e = withServer(new Event(row.id), server);
        await e.init();
        candidates.push({ event: e, target: e.fuzzyTarget() });
    }
    // 关键词一个都没命中(且没有状态/日期筛选) -> 返回空, 不退化成"全部活动"
    const effective = onlyTimeFilters ? undefined : pruneDeadWords(resolved!, candidates.map(c => c.target));
    if (!onlyTimeFilters && !effective) return [];
    // 关系式(如歌曲等级区间)只对歌曲有意义, 活动搜索不消费 —— 只剩它时返回空, 不放行全部活动
    if (effective && Object.keys(effective).every(k => k === '_relationStr')) return [];

    const events: Event[] = [];
    for (const { event: e, target } of candidates) {
        if (effective && !match(effective, target, [])) continue;
        if (!statuses.every(t => t(e, now))) continue;
        if (windows.length && !windows.some(w => eventOverlapsWindow(e, w))) continue;
        events.push(e);
    }
    return events;
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
