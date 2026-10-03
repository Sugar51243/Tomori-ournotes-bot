import { ttl } from '../config/ttl';
import { logger } from '../logger';
import { SERVER_LIST } from '../features/types/Server';
import {
    KeywordDoc, KeywordEntityType, KEYWORD_ENTITY_LABELS, KEYWORD_FUZZY_TYPES,
    MAX_KEYWORDS_PER_ENTITY, MAX_KEYWORD_LENGTH
} from '../features/types/Keyword';
import { keywordsCollection } from './mongo';
import { normalizeSearchText, setKeywordOverlay, getBaseFuzzyConfig, FuzzySearchConfig } from '../search/fuzzySearch';
import { bumpRenderEpoch } from '../renderEpoch';

/**
 * 用户关键词的读写与检索接入。
 *
 * 三件事:
 * 1. **内存快照**(带 TTL): 搜索与详情图都读它, 不每次查库; 上传/删除后主动强刷。
 * 2. **模糊搜索覆盖层**: 把关键词并进 `fuzzySearch` 的别名表(见 fuzzySearch.setKeywordOverlay),
 *    磁盘索引缓存不受影响 —— 关键词来自数据库, 与 dataVersion 无关。
 * 3. **上传查重**: 同一关键词可挂在**同类型的多个实体**上(如两首歌共用一个别名),
 *    但不能跨类型共用(歌曲与角色不能共用), 也不得与任何现有实体名/别名重合。
 */

const DB_DISABLED = '服务器未启用数据库';

export type AddResult = { ok: true; keyword: string } | { ok: false; reason: string };
export type RemoveResult = { ok: true; removed: number } | { ok: false; reason: string };

const entityKey = (type: KeywordEntityType, id: number): string => `${type}:${id}`;

interface Snapshot {
    /** `${entityType}:${entityId}` -> 关键词原文(按上传时间升序) */
    byEntity: Map<string, string[]>;
    /** 模糊搜索用的别名覆盖层 */
    overlay: FuzzySearchConfig;
    /** 每实体的关键词条数(上限校验用) */
    countByEntity: Map<string, number>;
    /** 归一化关键词 -> 已占用它的实体类型(跨类型查重: 一个关键词只允许出现在一类里) */
    typesByNorm: Map<string, Set<KeywordEntityType>>;
}

const EMPTY: Snapshot = { byEntity: new Map(), overlay: {}, countByEntity: new Map(), typesByNorm: new Map() };

let snapshot: Snapshot | undefined;
let loadedAt = 0;
let inflight: Promise<void> | undefined;

function buildSnapshot(docs: KeywordDoc[]): Snapshot {
    const byEntity = new Map<string, string[]>();
    const countByEntity = new Map<string, number>();
    const typesByNorm = new Map<string, Set<KeywordEntityType>>();
    const overlay: FuzzySearchConfig = {};
    for (const doc of docs) {
        const key = entityKey(doc.entityType, doc.entityId);
        const list = byEntity.get(key);
        if (list) list.push(doc.keyword);
        else byEntity.set(key, [doc.keyword]);
        countByEntity.set(key, (countByEntity.get(key) ?? 0) + 1);
        const owners = typesByNorm.get(doc.normKeyword) ?? new Set<KeywordEntityType>();
        owners.add(doc.entityType);
        typesByNorm.set(doc.normKeyword, owners);

        // 与 fuzzyIndex 的 aliasVariants 同口径: 原形与去标点形都要进, 否则带标点的关键词匹配不上
        const forms = new Set<string>();
        const lower = doc.keyword.toLowerCase();
        if (lower) forms.add(lower);
        const stripped = normalizeSearchText(doc.keyword);
        if (stripped) forms.add(stripped);
        if (forms.size === 0) continue;

        const typeKey = KEYWORD_FUZZY_TYPES[doc.entityType];
        const bucket = (overlay[typeKey] ??= {});
        const aliases = (bucket[String(doc.entityId)] ??= []);
        for (const form of forms) if (!aliases.includes(form)) aliases.push(form);
    }
    return { byEntity, overlay, countByEntity, typesByNorm };
}

function apply(next: Snapshot): void {
    snapshot = next;
    loadedAt = Date.now();
    setKeywordOverlay(next.overlay);
}

/**
 * 确保关键词快照已装载(TTL 内直接返回)。数据库未启用时得到空快照, 不抛错。
 * @param force 上传/删除后传 true, 立刻重读
 */
export async function ensureKeywordsLoaded(force = false): Promise<void> {
    if (!force && snapshot && Date.now() - loadedAt < ttl.keywordCacheTtlS * 1000) return;
    if (!inflight) {
        inflight = (async () => {
            const collection = await keywordsCollection().catch(() => undefined);
            if (!collection) {
                apply(EMPTY);
                return;
            }
            const docs = await collection.find({}).sort({ createdAt: 1 }).toArray();
            const next = buildSnapshot(docs as KeywordDoc[]);
            apply(next);
            logger('keywords', `loaded ${docs.length} keywords for ${next.byEntity.size} entities`);
        })().catch(e => {
            // 数据库抖动不该让搜索与出图挂掉: 保留旧快照(或空快照)
            logger('keywords', `load failed: ${e instanceof Error ? e.message : e}`);
        }).finally(() => {
            inflight = undefined;
        });
    }
    await inflight;
}

/** 某实体已上传的关键词(展示顺序 = 上传时间升序); 数据库未启用或没上传过时返回 [] */
export async function keywordsForEntity(type: KeywordEntityType, id: number): Promise<string[]> {
    await ensureKeywordsLoaded();
    return snapshot?.byEntity.get(entityKey(type, id)) ?? [];
}

// ---------------------------------------------------------------- 上传查重

interface EntityAliasIndex {
    /** 归一化别名 -> 归属(报错文案用) */
    owners: Map<string, { type: string; id: string }>;
    /** `${fuzzyType}:${id}` 全集(校验实体是否存在) */
    entities: Set<string>;
    /** 四区域索引缓存键拼接; 变化则重建 */
    key: string;
}

/**
 * 参与「与实体名重合」判重的别名类型。
 * 除实体本身外还纳入卡片属性(cardType)与贴纸(stampId) —— 它们同样在别名表里,
 * 一个叫「绯红」的关键词会让检索语义发浑, 顺手拒掉最省心。
 */
const DEDUPE_TYPES = ['bandId', 'characterId', 'songId', 'cardId', 'supportCardId', 'gachaId', 'eventId', 'cardType', 'stampId'];

/** 判重命中时用于报错文案(fuzzy 类型键 -> 中文名) */
const DEDUPE_TYPE_LABELS: Record<string, string> = {
    bandId: '乐团',
    characterId: '角色',
    songId: '歌曲',
    cardId: '角色卡',
    supportCardId: '支援卡',
    gachaId: '卡池',
    eventId: '活动',
    cardType: '属性',
    stampId: '贴纸'
};

let aliasIndex: EntityAliasIndex | undefined;

/**
 * 现有实体名的归一化别名集合 —— 直接复用已构建的模糊索引, 不另建数据源。
 * 四个区域取并集: id 空间全区一致, 同一实体在哪个区域都是它自己;
 * 只按单区域判重会出现「在 jp 合法、到 tw 却抢了真名」的不一致。
 *
 * 用动态 import 拿 fuzzyIndex: fuzzyIndex 反过来要 import 本模块装载关键词,
 * 静态互相 import 会成环, 而这条路径只在低频的上传里走。
 */
async function entityNameAliasIndex(): Promise<EntityAliasIndex | undefined> {
    const { ensureFuzzyIndex } = await import('../search/fuzzyIndex');
    const keys = await Promise.all(SERVER_LIST.map(async s => {
        try {
            return await ensureFuzzyIndex(s);
        } catch (e) {
            logger('keywords', `[${s}] fuzzy index unavailable for dedupe: ${e instanceof Error ? e.message : e}`);
            return '';
        }
    }));
    const key = keys.join('|');
    if (aliasIndex && aliasIndex.key === key) return aliasIndex;
    if (!key) return undefined;

    const owners = new Map<string, { type: string; id: string }>();
    const entities = new Set<string>();
    for (let i = 0; i < SERVER_LIST.length; i++) {
        if (!keys[i]) continue;
        const cfg = getBaseFuzzyConfig(SERVER_LIST[i]);
        for (const type of DEDUPE_TYPES) {
            const bucket = cfg[type];
            if (!bucket) continue;
            for (const [id, aliases] of Object.entries(bucket)) {
                entities.add(`${type}:${id}`);
                for (const alias of aliases) {
                    if (typeof alias !== 'string') continue;
                    const norm = normalizeSearchText(alias);
                    if (norm && !owners.has(norm)) owners.set(norm, { type, id });
                }
            }
        }
    }
    aliasIndex = { owners, entities, key };
    logger('keywords', `entity alias index built: ${owners.size} names, ${entities.size} entities`);
    return aliasIndex;
}

/** 上传关键词: 归一化 -> 查重 -> 入库 -> 刷新快照与搜索覆盖层 */
export async function addKeyword(input: {
    entityType: KeywordEntityType;
    entityId: number;
    keyword: string;
    userId: string;
}): Promise<AddResult> {
    const { entityType, entityId, userId } = input;
    const keyword = input.keyword.trim();
    if (!keyword) return { ok: false, reason: '关键词不能为空' };
    if (keyword.length > MAX_KEYWORD_LENGTH) return { ok: false, reason: `关键词过长（上限 ${MAX_KEYWORD_LENGTH} 字）` };
    const norm = normalizeSearchText(keyword);
    if (!norm) return { ok: false, reason: '关键词去掉标点后为空' };

    const collection = await keywordsCollection().catch(() => undefined);
    if (!collection) return { ok: false, reason: DB_DISABLED };

    const fuzzyType = KEYWORD_FUZZY_TYPES[entityType];
    const aliases = await entityNameAliasIndex();
    if (aliases) {
        if (!aliases.entities.has(`${fuzzyType}:${entityId}`)) {
            return { ok: false, reason: `该${KEYWORD_ENTITY_LABELS[entityType]}不存在` };
        }
        const owner = aliases.owners.get(norm);
        if (owner) {
            const what = DEDUPE_TYPE_LABELS[owner.type] ?? '现有条目';
            return { ok: false, reason: `该关键词与现有${what}名重合（${owner.type} ${owner.id}）` };
        }
    }

    await ensureKeywordsLoaded();
    // 跨类型查重: 同一关键词只允许出现在一类实体里(同类型的多个实体可以共用)
    const owners = snapshot?.typesByNorm.get(norm);
    if (owners && [...owners].some(t => t !== entityType)) {
        const what = [...owners].filter(t => t !== entityType).map(t => KEYWORD_ENTITY_LABELS[t]).join(' / ');
        return { ok: false, reason: `该关键词已用于${what}，不能跨类型共用` };
    }
    const key = entityKey(entityType, entityId);
    if ((snapshot?.countByEntity.get(key) ?? 0) >= MAX_KEYWORDS_PER_ENTITY) {
        return { ok: false, reason: `该条目关键词已达上限（${MAX_KEYWORDS_PER_ENTITY} 个）` };
    }
    if (snapshot?.byEntity.get(key)?.some(k => normalizeSearchText(k) === norm)) {
        return { ok: false, reason: '该关键词已存在' };
    }

    try {
        await collection.insertOne({ entityType, entityId, keyword, normKeyword: norm, userId, createdAt: new Date() });
    } catch (e) {
        // 并发上传同一关键词时由唯一索引兜底
        if ((e as { code?: number }).code === 11000) return { ok: false, reason: '该关键词已存在' };
        throw e;
    }

    await ensureKeywordsLoaded(true);
    bumpRenderEpoch();
    logger('keywords', `[${entityType} ${entityId}] +${keyword} by ${userId}`);
    return { ok: true, keyword };
}

/** 删除关键词: 只能删自己上传的(弱鉴权, 与 /friend/delete 同级) */
export async function removeKeyword(input: {
    entityType: KeywordEntityType;
    entityId: number;
    keyword: string;
    userId: string;
}): Promise<RemoveResult> {
    const norm = normalizeSearchText(input.keyword);
    if (!norm) return { ok: false, reason: '关键词去掉标点后为空' };

    const collection = await keywordsCollection().catch(() => undefined);
    if (!collection) return { ok: false, reason: DB_DISABLED };

    const result = await collection.deleteOne({
        entityType: input.entityType,
        entityId: input.entityId,
        normKeyword: norm,
        userId: input.userId
    });
    if (result.deletedCount > 0) {
        await ensureKeywordsLoaded(true);
        bumpRenderEpoch();
        logger('keywords', `[${input.entityType} ${input.entityId}] -${input.keyword} by ${input.userId}`);
    }
    return { ok: true, removed: result.deletedCount };
}
