import { isInteger } from './routers/utils';
import { logger } from './logger';
import { Server } from './types/Server';

// 移植自 tsugu-bangdream-bot backend/src/fuzzySearch.ts, 配置改为由 fuzzyIndex 注入。
// 各区域的曲库/卡池不同, 别名索引必须按区域分片。
export interface FuzzySearchConfig {
    [type: string]: { [key: string]: (string | number)[] };
}

/** 基础索引(fuzzyIndex 按「区域 + dataVersion」构建并注入) */
const baseConfigs = new Map<Server, FuzzySearchConfig>();
/**
 * 关键词覆盖层(全局, 与区域无关)。
 *
 * 用户关键词存在 MongoDB 里, 随时会变, 所以**绝不能写进磁盘索引缓存** ——
 * 否则 DB 一变就要让几十 KB 的索引失效重建。这里把它作为独立的一层,
 * 与基础索引合并后才交给 fuzzySearch()。
 */
let keywordOverlay: FuzzySearchConfig = {};
/** 合并结果的缓存(基础索引或覆盖层任一变化即整体清空) */
const mergedConfigs = new Map<Server, FuzzySearchConfig>();

function mergeConfigs(base: FuzzySearchConfig, overlay: FuzzySearchConfig): FuzzySearchConfig {
    const out: FuzzySearchConfig = {};
    for (const source of [base, overlay]) {
        for (const [type, entries] of Object.entries(source)) {
            const target = (out[type] ??= {});
            for (const [key, values] of Object.entries(entries)) {
                const list = (target[key] ??= []);
                for (const value of values) if (!list.includes(value)) list.push(value);
            }
        }
    }
    return out;
}

export function getFuzzyConfig(server: Server): FuzzySearchConfig {
    let merged = mergedConfigs.get(server);
    if (!merged) {
        merged = mergeConfigs(baseConfigs.get(server) ?? {}, keywordOverlay);
        mergedConfigs.set(server, merged);
    }
    return merged;
}

/** 纯基础索引(不含关键词): 关键词查重与「实体是否存在」校验用 */
export function getBaseFuzzyConfig(server: Server): FuzzySearchConfig {
    return baseConfigs.get(server) ?? {};
}

/**
 * 注入/更新关键词覆盖层, 并重建各区域的整体同名索引。
 * 上传或删除关键词后调用, 立即生效。
 */
export function setKeywordOverlay(overlay: FuzzySearchConfig): void {
    keywordOverlay = overlay;
    mergedConfigs.clear();
    for (const server of baseConfigs.keys()) rebuildWholeNameIndex(server);
}

/** dataVersion 变化时清空(不传区域则全清)。保留关键词覆盖层 —— 它来自数据库, 与版本无关 */
export function resetFuzzyConfig(server?: Server): void {
    if (server) {
        baseConfigs.delete(server);
        mergedConfigs.delete(server);
    } else {
        baseConfigs.clear();
        mergedConfigs.clear();
    }
    for (const s of new Set([...baseConfigs.keys(), ...wholeNameIndexes.keys()])) rebuildWholeNameIndex(s);
}

/**
 * 整体同名规则: 搜索词整体与某个名字完全同名时, 直接按该分类查询, 不再分词。
 * - 基础索引里只认**乐团/角色**两类 —— 歌名/卡名若也走短路, "歌名 + 筛选词"这类组合查询会失效
 * - 关键词覆盖层里四类都认 —— 关键词可能带空格, 走分词会被拆开而匹配不到
 */
const WHOLE_NAME_TYPES = ['bandId', 'characterId'];
const KEYWORD_WHOLE_NAME_TYPES = ['characterId', 'cardId', 'supportCardId', 'songId'];

/**
 * 名称归一化: 转小写并去掉标点/空格。
 * 模糊索引的别名变体、整体同名判定、关键词查重与入库都走这一份规则,
 * 否则同一串文字在三处会得出不同结果(如 "MyGO!!!!!" 与 "mygo")。
 */
export function normalizeSearchText(name: string): string {
    return name.toLowerCase().replace(/[^0-9a-z一-鿿぀-ヿ가-힯]/g, '');
}

/** 归一化名字 -> 分类键与 id(整体同名规则用; 由 setFuzzyConfig 构建), 按区域分片 */
const wholeNameIndexes = new Map<Server, Map<string, { type: string; id: string | number }[]>>();

/** 用基础索引 + 关键词覆盖层重建某区域的「整体同名」索引 */
function rebuildWholeNameIndex(server: Server): void {
    const index = new Map<string, { type: string; id: string | number }[]>();
    const collect = (config: FuzzySearchConfig | undefined, types: string[]): void => {
        if (!config) return;
        for (const type of types) {
            for (const [key, aliases] of Object.entries(config[type] ?? {})) {
                for (const alias of aliases) {
                    if (typeof alias !== 'string') continue;
                    const norm = normalizeSearchText(alias);
                    if (!norm) continue;
                    const list = index.get(norm) ?? [];
                    if (!list.some(e => e.type === type && String(e.id) === key)) {
                        list.push({ type, id: isInteger(key) ? parseInt(key, 10) : key });
                    }
                    index.set(norm, list);
                }
            }
        }
    };
    collect(getBaseFuzzyConfig(server), WHOLE_NAME_TYPES);
    collect(keywordOverlay, KEYWORD_WHOLE_NAME_TYPES);
    wholeNameIndexes.set(server, index);
    logger('fuzzySearch', `[${server}] fuzzy config updated: ${Object.keys(getBaseFuzzyConfig(server)).join(', ')}, whole-name entries: ${index.size}`);
}

export function setFuzzyConfig(server: Server, config: FuzzySearchConfig): void {
    baseConfigs.set(server, config);
    mergedConfigs.delete(server);
    rebuildWholeNameIndex(server);
}

export interface FuzzySearchResult {
    [key: string]: (string | number)[];
}

// 自定义验证函数
export function isFuzzySearchResult(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return Object.values(value).every(
        (arr) =>
            Array.isArray(arr) &&
            arr.every((item) => typeof item === 'string' || typeof item === 'number')
    );
}

function extractLvNumber(str: string): number | null {
    const regex = /^lv(\d+)$/i;
    const match = str.match(regex);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return null;
}

function isValidRelationStr(_relationStr: string): boolean {
    const lessThanPattern = /^<\d+$/;
    const greaterThanPattern = /^>\d+$/;
    const rangePattern = /^\d+-\d+$/;

    return lessThanPattern.test(_relationStr) ||
        greaterThanPattern.test(_relationStr) ||
        rangePattern.test(_relationStr);
}

export function fuzzySearch(server: Server, keyword: string): FuzzySearchResult {
    const fuzzyConfig = getFuzzyConfig(server);
    // 整体同名规则: 与乐团名/角色名完全同名时只按该分类查询, 不再分词、不做子串回退。
    // 否则 "Ave Mujica" 会被拆成 ave/mujica, 经 _all 子串回退误配 "unravel"(含 ave)。
    const wholeName = wholeNameIndexes.get(server)?.get(normalizeSearchText(keyword));
    if (wholeName && wholeName.length > 0) {
        const matches: FuzzySearchResult = {};
        for (const { type, id } of wholeName) {
            (matches[type] ??= []).push(id);
        }
        return matches;
    }

    //兼容引号
    const keywordList = (keyword.match(/["“”『』「」]([^"“”『』「」]+)["“”『』「」]|\S+/g) || []).map(item =>
        item.replace(/^[\"“”『』「」]|[\"“”『』「」]$/g, '') // 去掉前后可能的中英文引号
    );

    const matches: { [key: string]: (string | number)[] } = {};

    for (const keyword_org of keywordList) {
        let matched = false;
        let keyword = keyword_org.toLowerCase();

        if (isInteger(keyword)) {
            const num = parseInt(keyword, 10);
            if (!matches['_number']) {
                matches['_number'] = [];
            }
            matches['_number'].push(num);
            continue;
        }

        keyword = keyword.replace(/&gt;/g, '>');
        keyword = keyword.replace(/&lt;/g, '<');
        keyword = keyword.replace(/＞/g, '>');
        keyword = keyword.replace(/＜/g, '<');

        const lvNumber = extractLvNumber(keyword);
        if (lvNumber !== null) {
            if (!matches['songLevels']) {
                matches['songLevels'] = [];
            }
            matches['songLevels'].push(lvNumber);
            continue;
        }

        if (isValidRelationStr(keyword)) {
            if (!matches['_relationStr']) {
                matches['_relationStr'] = [];
            }
            matches['_relationStr'].push(keyword);
            continue;
        }

        for (const type in fuzzyConfig) {
            const typeConfig = fuzzyConfig[type];
            for (const key in typeConfig) {
                const values = typeConfig[key];
                for (const value of values) {
                    if (typeof value === 'string') {
                        if (value.toLowerCase() === keyword) {
                            if (!matches[type]) {
                                matches[type] = [];
                            }
                            const numKey = isInteger(key) ? parseInt(key, 10) : key;
                            matches[type].push(numKey);
                            matched = true;
                            continue;
                        }
                    }

                    if (Array.isArray(value)) {
                        if (value.includes(keyword)) {
                            if (!matches[type]) {
                                matches[type] = [];
                            }
                            const numKey = isInteger(key) ? parseInt(key, 10) : key;
                            matches[type].push(numKey);
                            matched = true;
                            continue;
                        }
                    }

                    if (typeof value === 'object') {
                        if (Object.keys(value).includes(keyword)) {
                            if (!matches[type]) {
                                matches[type] = [];
                            }
                            const numKey = isInteger(key) ? parseInt(key, 10) : key;
                            matches[type].push(numKey);
                            matched = true;
                            continue;
                        }
                    }
                }
            }
        }

        if (!matched) {
            if (!matches['_all']) {
                matches['_all'] = [];
            }
            matches['_all'].push(keyword_org);
        }
    }

    return matches;
}

/**
 * target 的某个字符串字段(含字符串数组)是否包含该词(忽略大小写)。
 * `_all` 的子串匹配与调用方的"死词剔除"(search.ts 的 pruneDeadWords)共用同一口径。
 */
export function targetHasSubstring(target: Record<string, unknown>, word: string): boolean {
    for (const key in target) {
        const value = target[key];
        if (typeof value === 'string') {
            if (value.toLowerCase().includes(word)) return true;
        } else if (Array.isArray(value)) {
            if (value.some(v => typeof v === 'string' && v.toLowerCase().includes(word))) return true;
        }
    }
    return false;
}

export function match(matches: FuzzySearchResult, target: any, numberTypeKey: string[]): boolean {
    if (!target) {
        return false;
    }
    if (Object.keys(matches).length == 0) {
        return true;
    }
    let hasTypedKey = false;

    for (const key in matches) {
        if (key === '_number' || key === '_relationStr' || key === '_all') {
            continue;
        }
        hasTypedKey = true;

        // 匹配关键词
        if (target[key] !== undefined) {
            // 处理 Array 类型
            if (Array.isArray(target[key])) {
                let matchArray = false;
                for (let i = 0; i < target[key].length; i++) {
                    const element = target[key][i];

                    // 对比字符串（忽略大小写）
                    if (
                        typeof element === 'string' &&
                        matches[key].some((m: any) => typeof m === 'string' && m.toLowerCase() === element.toLowerCase())
                    ) {
                        matchArray = true;
                        break;
                    }

                    // 对比数字（songLevels 等）
                    if (
                        typeof element === 'number' &&
                        matches[key].some((m: any) => typeof m === 'number' && m === element)
                    ) {
                        matchArray = true;
                        break;
                    }
                }
                if (matchArray) {
                    continue;
                }
                // 任一 typed key 不命中 = 整体不命中(多参数 AND), 直接返回
                return false;
            }
            // 处理 Object (string, number) 类型
            else {
                if (
                    typeof target[key] === 'string' &&
                    matches[key].some((m: any) => typeof m === 'string' && m.toLowerCase() === target[key].toLowerCase())
                ) {
                    continue;
                }

                if (
                    typeof target[key] === 'number' &&
                    matches[key].some((m: any) => typeof m === 'number' && m === target[key])
                ) {
                    continue;
                }

                return false;
            }
        }

        // 处理指定的数字类型 key，比如 songLevels
        if (numberTypeKey.length > 0 && matches['_number'] !== undefined) {
            if (numberTypeKey.includes(key)) {
                if (matches['_number'].includes(target[key])) {
                    continue;
                }
                return false;
            }
        }
    }

    // `_all`(索引没解析成实体的词)按子串在 target 的字符串字段里找。
    // 多参数 = **同时满足**: 每个词都要出现, 任一没出现就整体不命中 ——
    // 「nnk ssr」= nnk 的结果 ∩ ssr 的结果, 而不是命中一个就返回。
    // (谁都命中不了的"死词"不在这里处理: 调用方按候选全集先把它剔掉, 见 search.ts 的 pruneDeadWords)
    if (matches['_all'] !== undefined && matches['_all'].length > 0) {
        const words = (matches['_all'] as Array<string | number>).map(v => String(v).toLowerCase());
        return words.every(word => targetHasSubstring(target, word));
    }

    // 走到这里 = 上面每个 typed key 都命中了(有任一不命中会直接 return false)
    if (hasTypedKey) {
        return true;
    }
    // 只剩 _relationStr(歌曲 ID 范围)时, 过滤交给调用方的 checkRelationList, 这里不参与判定;
    // 只剩 _number 时维持原行为(不参与过滤 = 不命中)。
    return matches['_relationStr'] !== undefined;
}

// 数字与范围函数
export function checkRelationList(num: number, _relationStrList: string[]): boolean {
    function checkRelation(num: number, _relationStr: string): boolean {
        const lessThanMatch = _relationStr.match(/^<(\d+)$/);
        const greaterThanMatch = _relationStr.match(/^>(\d+)$/);
        const rangeMatch = _relationStr.match(/^(\d+)-(\d+)$/);

        if (lessThanMatch) {
            const boundary = parseFloat(lessThanMatch[1]);
            return num < boundary;
        }

        if (greaterThanMatch) {
            const boundary = parseFloat(greaterThanMatch[1]);
            return num > boundary;
        }

        if (rangeMatch) {
            const lowerBoundary = parseFloat(rangeMatch[1]);
            const upperBoundary = parseFloat(rangeMatch[2]);
            return num >= lowerBoundary && num <= upperBoundary;
        }

        throw new Error('Invalid relation string format');
    }

    for (let i = 0; i < _relationStrList.length; i++) {
        try {
            if (checkRelation(num, _relationStrList[i])) {
                return true;
            }
        } catch {
            logger('fuzzySearch', 'Invalid relation string format');
        }
    }
    return false;
}
