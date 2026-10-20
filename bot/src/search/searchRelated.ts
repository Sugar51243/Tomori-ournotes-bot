import { Server, withServer } from '../features/types/Server';
import { storeFor } from '../db/adapter';
import { getFuzzyConfig } from './fuzzySearch';
import { Event } from '../features/types/Event';
import {
    relatedEventIdsOfCard, relatedEventIdsOfGacha, relatedEventIdsOfSong,
    relatedGachaIdsOfCard, relatedGachaIdsOfEvent
} from '../db/adapter';

/**
 * 关联维度搜索(模糊搜索的第二层)。
 *
 * 各端点的搜索优先级固定为 **ID > 自信息 > 关联**:
 * 关键词命中实体自身维度(名称/别名/等级/关键词)时只用自身维度, 不混入关联结果;
 * 自身维度无命中时, 才把「其它实体类型」的命中按下面的映射翻成本端点类型的结果。
 *
 * 关系口径全部复用 src/db/relations.ts(显式字段优先; 活动↔卡池为既有启发式), 这里只做 id 映射。
 * 所有函数都不截断结果 —— 搜索多命中由调用方出列表图, 截断是详情图栏位的事。
 */

type Id = string | number;

const num = (v: Id): number => Number(v);
const uniq = (xs: number[]): number[] => [...new Set(xs)];

/**
 * `_all` 子串回退: 未解析成实体的词, 用索引别名做子串匹配(match() 的 `_all` 同口径),
 * 得到命中的 id。上游名称常带后缀(如活动名 "アイの奔流 atoz"), 只搜词干时靠这里命中。
 *
 * @returns ids 与 `used` —— 被用来命中实体的词。这些词**已经**通过这个维度表达了语义,
 *          调用方要把它们从 `_all` 里移除, 否则会再当一次子串约束:
 *          「mujica」解析成乐团是对的, 但卡片名里恰好有 2 张含 "mujica",
 *          不消费掉就会把 28 张乐团卡缩成那 2 张。
 */
export function substringMatch(server: Server, type: string, words: string[]): { ids: number[]; used: Set<string> } {
    const used = new Set<string>();
    if (words.length === 0) return { ids: [], used };
    const bucket = getFuzzyConfig(server)[type] ?? {};
    const lowered = words.map(w => w.toLowerCase());
    const ids: number[] = [];
    for (const [key, aliases] of Object.entries(bucket)) {
        const hit = aliases.some(alias => {
            if (typeof alias !== 'string') return false;
            let any = false;
            for (const w of lowered) {
                if (alias.includes(w)) {
                    used.add(w);
                    any = true;
                }
            }
            return any;
        });
        if (hit) ids.push(Number(key));
    }
    return { ids, used };
}

/** 只取命中 id 的简版(不关心消化了哪些词时用) */
export function substringIds(server: Server, type: string, words: string[]): number[] {
    return substringMatch(server, type, words).ids;
}

/** 角色 id -> 其所属乐团 id(乐团端点按角色搜索、歌曲按角色搜索都走这里) */
export async function bandsOfCharacters(server: Server, characterIds: Id[]): Promise<number[]> {
    const store = storeFor(server);
    const out: number[] = [];
    for (const id of uniq(characterIds.map(num))) {
        const character = await store.characterById(id).catch(() => undefined);
        if (character?.bandID) out.push(Number(character.bandID));
    }
    return uniq(out);
}

/** 活动 id -> 该活动的加成/相关角色 id */
export async function characterIdsOfEvents(server: Server, eventIds: Id[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of uniq(eventIds.map(num))) {
        const event = withServer(new Event(id), server);
        await event.init();
        if (event.isExist) out.push(...event.bonusCharacterIds);
    }
    return uniq(out);
}

/**
 * 活动 id -> 该活动的曲目 id(活动本曲 + 挑战曲)。
 * 用 relatedIndex 的「曲目 -> 活动」倒排取反向映射, 与详情图的关联口径同源。
 */
export async function songIdsOfEvents(server: Server, eventIds: Id[]): Promise<number[]> {
    const index = await storeFor(server).relatedIndex();
    const wanted = new Set(eventIds.map(num));
    const out: number[] = [];
    for (const [musicId, evIds] of index.eventIdsByMusic) {
        if (evIds.some(e => wanted.has(e))) out.push(Number(musicId));
    }
    return uniq(out);
}

/** 角色/乐团 id -> 这些角色(或乐团成员)名下的卡片键(m:<id> / s:<id>) */
export async function cardKeysOfCharacters(
    server: Server,
    characterIds: Id[] = [],
    bandIds: Id[] = []
): Promise<string[]> {
    const store = storeFor(server);
    const chars = new Set(characterIds.map(num));
    const bands = new Set(bandIds.map(num));
    if (bands.size > 0) {
        // 卡片行只带 characterID, 乐团要先展开成成员
        for (const row of await store.characters().catch(() => [])) {
            if (row.bandID && bands.has(Number(row.bandID))) chars.add(Number(row.id));
        }
    }
    if (chars.size === 0) return [];

    const out: string[] = [];
    for (const row of await store.cardList().catch(() => [])) {
        if (chars.has(Number(row.characterID))) out.push(`m:${row.id}`);
    }
    for (const row of await store.supportCardList().catch(() => [])) {
        if ((row.characterIDs ?? []).some(id => chars.has(Number(id)))) out.push(`s:${row.id}`);
    }
    return out;
}

/** 卡片键 -> 相关活动 id(活动卡 / 加成对象卡) */
export async function eventIdsOfCardKeys(server: Server, keys: string[]): Promise<number[]> {
    const out: number[] = [];
    for (const key of keys) out.push(...await relatedEventIdsOfCard(server, key));
    return uniq(out);
}

/** 卡片键 -> 相关卡池 id(该卡作为 UP 出现的卡池) */
export async function gachaIdsOfCardKeys(server: Server, keys: string[]): Promise<number[]> {
    const out: number[] = [];
    for (const key of keys) out.push(...await relatedGachaIdsOfCard(server, key));
    return uniq(out);
}

/** 歌曲 id -> 相关活动 id(活动本曲 / 挑战曲) */
export async function eventIdsOfSongIds(server: Server, songIds: Id[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of uniq(songIds.map(num))) out.push(...await relatedEventIdsOfSong(server, id));
    return uniq(out);
}

/** 卡池 id -> 相关活动 id(启发式) */
export async function eventIdsOfGachaIds(server: Server, gachaIds: Id[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of uniq(gachaIds.map(num))) out.push(...await relatedEventIdsOfGacha(server, id));
    return uniq(out);
}

/** 活动 id -> 相关卡池 id(启发式) */
export async function gachaIdsOfEventIds(server: Server, eventIds: Id[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of uniq(eventIds.map(num))) out.push(...await relatedGachaIdsOfEvent(server, id));
    return uniq(out);
}
