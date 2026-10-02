import { Server } from '../types/Server';
import { storeFor, regionFor } from './region';
import { parseGameDate } from '../types/Gacha';

/**
 * 实体之间的关联查询(相关卡池 / 相关活动)。
 *
 * 上游 master 表里**只有三种关联是显式字段**, 第四种只能推断:
 *
 * | 关联 | 依据 | 可信度 |
 * | --- | --- | --- |
 * | 歌曲 → 活动 | `MasterEvent.musicId`、`MasterChallengeMusic.liveMusicId` | 显式 |
 * | 角色卡/支援卡 → 活动 | `MasterEventPickUpCard`、`MasterEventEffect` | 显式 |
 * | 角色卡/支援卡 → 卡池 | `MasterGacha` → `MasterGachaLot` → `MasterGachaPrize.pickUpType=2` | 显式(倒排) |
 * | 活动 ↔ 卡池 | 无字段, 按「UP 卡重合 + 时间区间重叠」推断 | **启发式** |
 *
 * 倒排索引由 `MasterDataStore.relatedIndex()` 构建(那里只存 id 与原始时间串);
 * 本模块负责时间解析、命名与跨区域兜底。
 */

/** 关联卡片键: 成员卡 `m:<id>` / 支援卡 `s:<id>`(两个 id 空间重叠, 必须带前缀) */
export function cardKey(resourceType: number, resourceId: number): string | undefined {
    if (!resourceId) return undefined;
    if (resourceType === 2) return `m:${resourceId}`;
    if (resourceType === 3) return `s:${resourceId}`;
    return undefined;
}

export interface RelatedGacha {
    gachaId: number;
    name: string;
    /** 供 eventAssetImage 用的逻辑路径(跨区域回退取图) */
    imagePath: string;
    imageCacheKey: string;
}

export interface RelatedEvent {
    eventId: number;
    name: string;
    imagePath: string;
    imageCacheKey: string;
}

/** 详情图最多列出几个关联项: 再多会把图撑得过长 */
const MAX_RELATED = 6;

/** 解析主数据里的时间串(按所属区域的本地时间); 空串/非法值返回 undefined */
function parseTime(value: unknown, server: Server): Date | undefined {
    const s = String(value ?? '').trim();
    if (!s || s === 'null') return undefined;
    return parseGameDate(s, server);
}

/**
 * 该区域的卡池表是否可用。
 * 实测 en 区上游**没有** MasterGacha/MasterGachaLot/MasterGachaPrize(一律 404),
 * 按项目既有规则「该服自己没有就借港澳台」退回 tw —— 卡池 id 全区一致, 借的只是行数据。
 */
async function withGachaFallback(server: Server): Promise<Server> {
    if (server === 'tw') return 'tw';
    const rows = await storeFor(server).gachaList().catch(() => []);
    return rows.length > 0 ? server : 'tw';
}

/** 活动表同理(实测四区域都有数据, 这里只是防御性兜底) */
async function withEventFallback(server: Server): Promise<Server> {
    if (server === 'tw') return 'tw';
    const rows = await storeFor(server).eventList().catch(() => []);
    return rows.length > 0 ? server : 'tw';
}

/** 名称按**展示区域**的语言解析; 该区域缺这条文本时退回数据来源区域 */
async function resolveName(textId: string, display: Server, source: Server): Promise<string> {
    if (!textId) return '';
    const name = await regionFor(display).t(textId);
    if (name && name !== textId) return name;
    return source === display ? name : regionFor(source).t(textId);
}

function gachaTile(server: Server, gachaId: number, name: string, bannerAssetName: string): RelatedGacha {
    const file = bannerAssetName.split('/').at(-1) || `gacha_${gachaId}`;
    return {
        gachaId,
        name,
        imagePath: `${bannerAssetName}/${file}.webp`,
        // 与 gachaDetail 的磁盘缓存分开命名: 关联位可能借别的区域的素材
        imageCacheKey: `related/gacha/${gachaId}_banner.webp`
    };
}

function eventTile(eventId: number, name: string, logoAsset: string): RelatedEvent {
    const file = logoAsset.split('/').at(-1) || `event_${eventId}`;
    return {
        eventId,
        name,
        imagePath: `Image/Event/${logoAsset}/${file}.webp`,
        imageCacheKey: `related/event/${eventId}_logo.webp`
    };
}

/** 按开始时间倒序(取不到的排最后), 同时间按 id 倒序; 并截断到 MAX_RELATED */
function sortAndCap<T extends { startAt?: Date; id: number }>(items: T[]): T[] {
    return items
        .sort((a, b) => (b.startAt?.getTime() ?? -Infinity) - (a.startAt?.getTime() ?? -Infinity) || b.id - a.id)
        .slice(0, MAX_RELATED);
}

// ---------------------------------------------------------------- 卡 → 卡池/活动

/**
 * 关联 id 查询(**不截断**, 供模糊搜索使用; 详情图用的 tile 版本在下面按 MAX_RELATED 截断)。
 */
export async function relatedGachaIdsOfCard(server: Server, key: string): Promise<number[]> {
    const source = await withGachaFallback(server);
    return ((await storeFor(source).relatedIndex()).gachaIdsByCard.get(key) ?? []).slice();
}

export async function relatedEventIdsOfCard(server: Server, key: string): Promise<number[]> {
    const source = await withEventFallback(server);
    return ((await storeFor(source).relatedIndex()).eventIdsByCard.get(key) ?? []).slice();
}

/** 歌曲 id -> 相关活动 id(活动本曲 / 挑战曲) */
export async function relatedEventIdsOfSong(server: Server, songId: number): Promise<number[]> {
    const source = await withEventFallback(server);
    return ((await storeFor(source).relatedIndex()).eventIdsByMusic.get(songId) ?? []).slice();
}

async function relatedGachasForCard(server: Server, key: string): Promise<RelatedGacha[]> {
    const source = await withGachaFallback(server);
    const store = storeFor(source);
    const ids = await relatedGachaIdsOfCard(server, key);
    if (ids.length === 0) return [];

    const rows = await store.gachaList().catch(() => []);
    const index = await store.relatedIndex();
    const tiles: Array<RelatedGacha & { startAt?: Date; id: number }> = [];
    for (const id of ids) {
        const row = rows.find(g => g.id === id);
        if (!row) continue;
        tiles.push({
            ...gachaTile(source, id, await resolveName(row.nameTextId, server, source), row.bannerAssetName),
            startAt: parseTime(index.gachaTimes.get(id)?.startAt, source),
            id
        });
    }
    return sortAndCap(tiles).map(({ startAt: _s, id: _i, ...tile }) => tile);
}

async function relatedEventsForCard(server: Server, key: string): Promise<RelatedEvent[]> {
    const source = await withEventFallback(server);
    const ids = await relatedEventIdsOfCard(server, key);
    return eventTiles(server, source, ids);
}

async function relatedEventsForSong(server: Server, songId: number): Promise<RelatedEvent[]> {
    const source = await withEventFallback(server);
    const ids = await relatedEventIdsOfSong(server, songId);
    return eventTiles(server, source, ids);
}

/** 事件 id 列表 -> 详情图用的 tile(名称按展示区域解析, 按时间倒序截断) */
async function eventTiles(server: Server, source: Server, ids: number[]): Promise<RelatedEvent[]> {
    if (ids.length === 0) return [];
    const store = storeFor(source);
    const rows = await store.eventList().catch(() => []);
    const times = (await store.relatedIndex()).eventTimes;
    const tiles: Array<RelatedEvent & { startAt?: Date; id: number }> = [];
    for (const id of ids) {
        const row = rows.find(e => e.id === id);
        if (!row) continue;
        const nameId = String((row as Record<string, unknown>).nameTextId ?? '');
        tiles.push({
            ...eventTile(id, await resolveName(nameId, server, source), row.logoAsset),
            startAt: parseTime(times.get(id)?.startAt, source),
            id
        });
    }
    return sortAndCap(tiles).map(({ startAt: _s, id: _i, ...tile }) => tile);
}

// ---------------------------------------------------------------- 活动 ↔ 卡池(推断)

/**
 * 活动与卡池是否相关 —— **这套约定是启发式的, 只在这里实现一次**。
 *
 * 判据(用户指定): 卡池的 UP 卡集合与活动的卡集合(活动卡 ∪ 加成对象卡)**有交集**,
 * 且两者的时间区间**有重叠**。任一侧时间缺失时按开区间处理(实测多数卡池 `_startAt` 为空串),
 * 即退化为「只看卡片交集」, 免得因为缺时间而漏掉。
 *
 * 实测校验: 活动 1 的加成卡 {M61,M62,S62,S63} 恰好是卡池 10 的全部 UP 卡,
 * 且两者开始时间同为 2026/09/30 18:00。
 *
 * 已知取舍: 复刻池、纯道具池这类「UP 卡与当期活动卡不重合」的卡池不会被关联。
 */
export function eventGachaRelated(
    eventCards: Set<string> | undefined,
    eventStart: Date | undefined, eventEnd: Date | undefined,
    gachaUpCards: Set<string> | undefined,
    gachaStart: Date | undefined, gachaEnd: Date | undefined
): boolean {
    if (!eventCards || !gachaUpCards || eventCards.size === 0 || gachaUpCards.size === 0) return false;
    let hit = false;
    for (const key of eventCards) {
        if (gachaUpCards.has(key)) {
            hit = true;
            break;
        }
    }
    if (!hit) return false;
    const a0 = eventStart?.getTime() ?? -Infinity;
    const a1 = eventEnd?.getTime() ?? Infinity;
    const b0 = gachaStart?.getTime() ?? -Infinity;
    const b1 = gachaEnd?.getTime() ?? Infinity;
    return a0 <= b1 && b0 <= a1;
}

/** 活动 id -> 相关卡池 id(不截断, 供搜索; 判据同 eventGachaRelated) */
export async function relatedGachaIdsOfEvent(server: Server, eventId: number): Promise<number[]> {
    const source = await withGachaFallback(server);
    const store = storeFor(source);
    const index = await store.relatedIndex();
    const eventCards = index.cardKeysByEvent.get(eventId);
    if (!eventCards || eventCards.size === 0) return [];

    const eventTime = index.eventTimes.get(eventId);
    const eventStart = parseTime(eventTime?.startAt, source);
    const eventEnd = parseTime(eventTime?.endAt, source);

    const out: number[] = [];
    for (const row of await store.gachaList().catch(() => [])) {
        const gachaTime = index.gachaTimes.get(row.id);
        if (!eventGachaRelated(eventCards, eventStart, eventEnd, index.upCardKeysByGacha.get(row.id), parseTime(gachaTime?.startAt, source), parseTime(gachaTime?.endAt, source))) continue;
        out.push(row.id);
    }
    return out;
}

/** 卡池 id -> 相关活动 id(不截断, 供搜索; 判据同 eventGachaRelated) */
export async function relatedEventIdsOfGacha(server: Server, gachaId: number): Promise<number[]> {
    const source = await withEventFallback(server);
    const store = storeFor(source);
    const index = await store.relatedIndex();
    const upCards = index.upCardKeysByGacha.get(gachaId);
    if (!upCards || upCards.size === 0) return [];

    const gachaTime = index.gachaTimes.get(gachaId);
    const gachaStart = parseTime(gachaTime?.startAt, source);
    const gachaEnd = parseTime(gachaTime?.endAt, source);

    const out: number[] = [];
    for (const row of await store.eventList().catch(() => [])) {
        const eventTime = index.eventTimes.get(row.id);
        if (!eventGachaRelated(index.cardKeysByEvent.get(row.id), parseTime(eventTime?.startAt, source), parseTime(eventTime?.endAt, source), upCards, gachaStart, gachaEnd)) continue;
        out.push(row.id);
    }
    return out;
}

async function relatedGachasForEvent(server: Server, eventId: number): Promise<RelatedGacha[]> {
    const source = await withGachaFallback(server);
    const ids = await relatedGachaIdsOfEvent(server, eventId);
    if (ids.length === 0) return [];

    const store = storeFor(source);
    const index = await store.relatedIndex();
    const rows = await store.gachaList().catch(() => []);
    const tiles: Array<RelatedGacha & { startAt?: Date; id: number }> = [];
    for (const id of ids) {
        const row = rows.find(g => g.id === id);
        if (!row) continue;
        tiles.push({
            ...gachaTile(source, id, await resolveName(row.nameTextId, server, source), row.bannerAssetName),
            startAt: parseTime(index.gachaTimes.get(id)?.startAt, source),
            id
        });
    }
    return sortAndCap(tiles).map(({ startAt: _s, id: _i, ...tile }) => tile);
}

async function relatedEventsForGacha(server: Server, gachaId: number): Promise<RelatedEvent[]> {
    const source = await withEventFallback(server);
    return eventTiles(server, source, await relatedEventIdsOfGacha(server, gachaId));
}

// ---------------------------------------------------------------- 对外门面

/** 卡片(角色卡/支援卡)的相关卡池与相关活动 */
export async function relatedForCard(server: Server, kind: 'member' | 'support', cardId: number): Promise<{
    gachas: RelatedGacha[];
    events: RelatedEvent[];
}> {
    const key = `${kind === 'member' ? 'm' : 's'}:${cardId}`;
    const [gachas, events] = await Promise.all([
        relatedGachasForCard(server, key).catch(() => []),
        relatedEventsForCard(server, key).catch(() => [])
    ]);
    return { gachas, events };
}

/** 歌曲的相关活动 */
export function relatedEventsFor(songId: number, server: Server): Promise<RelatedEvent[]> {
    return relatedEventsForSong(server, songId).catch(() => []);
}

/** 卡池的相关活动 */
export function relatedEventsOfGacha(server: Server, gachaId: number): Promise<RelatedEvent[]> {
    return relatedEventsForGacha(server, gachaId).catch(() => []);
}

/** 活动的相关卡池 */
export function relatedGachasOfEvent(server: Server, eventId: number): Promise<RelatedGacha[]> {
    return relatedGachasForEvent(server, eventId).catch(() => []);
}
