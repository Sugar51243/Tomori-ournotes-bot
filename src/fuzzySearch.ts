import { isInteger } from './routers/utils';
import { logger } from './logger';
import { Server } from './types/Server';

// 移植自 tsugu-bangdream-bot backend/src/fuzzySearch.ts, 配置改为由 fuzzyIndex 注入。
// 各区域的曲库/卡池不同, 别名索引必须按区域分片。
export interface FuzzySearchConfig {
    [type: string]: { [key: string]: (string | number)[] };
}

const configs = new Map<Server, FuzzySearchConfig>();

export function getFuzzyConfig(server: Server): FuzzySearchConfig {
    return configs.get(server) ?? {};
}

/** dataVersion 变化时清空(不传区域则全清) */
export function resetFuzzyConfig(server?: Server): void {
    if (server) {
        configs.delete(server);
        wholeNameIndexes.delete(server);
    } else {
        configs.clear();
        wholeNameIndexes.clear();
    }
}

/**
 * 整体同名规则只认这两类: 搜索词整体与乐团名/角色名完全同名时, 直接按该分类查询。
 * 其余分类(歌名/卡名/卡池名等)仍走分词匹配, 以便"歌名 + 筛选词"这类组合查询不变。
 */
const WHOLE_NAME_TYPES = ['bandId', 'characterId'];

/** 名称归一化: 转小写并去掉标点/空格(与 fuzzyIndex 的 aliasVariants 同规则) */
function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^0-9a-z一-鿿぀-ヿ가-힯]/g, '');
}

/** 归一化名字 -> 分类键与 id(整体同名规则用; 由 setFuzzyConfig 构建), 按区域分片 */
const wholeNameIndexes = new Map<Server, Map<string, { type: string; id: string | number }[]>>();

export function setFuzzyConfig(server: Server, config: FuzzySearchConfig): void {
    configs.set(server, config);
    const index = new Map<string, { type: string; id: string | number }[]>();
    for (const type of WHOLE_NAME_TYPES) {
        for (const [key, aliases] of Object.entries(config[type] ?? {})) {
            for (const alias of aliases) {
                if (typeof alias !== 'string') continue;
                const norm = normalizeName(alias);
                if (!norm) continue;
                const list = index.get(norm) ?? [];
                if (!list.some(e => e.type === type && String(e.id) === key)) {
                    list.push({ type, id: isInteger(key) ? parseInt(key, 10) : key });
                }
                index.set(norm, list);
            }
        }
    }
    wholeNameIndexes.set(server, index);
    logger('fuzzySearch', `[${server}] fuzzy config updated: ${Object.keys(config).join(', ')}, whole-name entries: ${index.size}`);
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
    const wholeName = wholeNameIndexes.get(server)?.get(normalizeName(keyword));
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

export function match(matches: FuzzySearchResult, target: any, numberTypeKey: string[]): boolean {
    if (!target) {
        return false;
    }
    if (Object.keys(matches).length == 0) {
        return true;
    }
    let match = false;

    for (const key in matches) {
        if (key === '_number' || key === '_relationStr' || key === '_all') {
            continue;
        }

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
                    match = true;
                    continue;
                } else {
                    match = false;
                    break;
                }
            }
            // 处理 Object (string, number) 类型
            else {
                if (
                    typeof target[key] === 'string' &&
                    matches[key].some((m: any) => typeof m === 'string' && m.toLowerCase() === target[key].toLowerCase())
                ) {
                    match = true;
                    continue;
                }

                if (
                    typeof target[key] === 'number' &&
                    matches[key].some((m: any) => typeof m === 'number' && m === target[key])
                ) {
                    match = true;
                    continue;
                }

                match = false;
                break;
            }
        }

        // 处理指定的数字类型 key，比如 songLevels
        if (numberTypeKey.length > 0 && matches['_number'] !== undefined) {
            if (numberTypeKey.includes(key)) {
                if (matches['_number'].includes(target[key])) {
                    match = true;
                    continue;
                } else {
                    match = false;
                    break;
                }
            }
        }
    }

    //如果在config中所有类型都不符合的情况下，检查 _all
    if (!match && matches['_all'] && Object.keys(matches).length == 1) {
        for (let i = 0; i < matches['_all'].length; i++) {
            let matchValue = matches['_all'][i];
            if (typeof matches['_all'][i] === 'string') {
                matchValue = (matches['_all'][i] as string).toLowerCase();
            }
            for (const key in target) {
                if (typeof target[key] === 'string') {
                    if (target[key].toLowerCase().includes(matchValue as string)) {
                        match = true;
                        break;
                    }
                }
                if (Array.isArray(target[key])) {
                    for (let j = 0; j < target[key].length; j++) {
                        if (typeof target[key][j] === 'string') {
                            if (target[key][j].toLowerCase().includes(matchValue as string)) {
                                match = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    return match;
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
