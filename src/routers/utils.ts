import type { FuzzySearchResult } from '../fuzzySearch';

export function isInteger(char: string): boolean {
    const regex = /^(0|[1-9]\d*)$/;
    return regex.test(char);
}

/**
 * 实体查询输入: 字符串(纯数字按 ID 直查, 其它文本走模糊搜索)或现成的模糊搜索结果。
 * 各 commandXxx 都按这个约定处理输入。
 */
export type EntityInput = string | FuzzySearchResult;

/**
 * 统一解析实体端点的查询输入(**简化传参**: 一个字段就能查)。
 *
 * 按优先级取第一个有值的字段:
 *   1. `id`              通用别名, 所有实体端点都收
 *   2. `idKeys`          端点专属 ID 字段(songId / gachaId / stampId / cardId / characterId / bandId / eventId ...)
 *   3. `text`            搜索文本; 纯数字字符串按 ID 直查(与各 commandXxx 的 isInteger 判定一致)
 *   4. `fuzzySearchResult`  经 /fuzzySearch 的现成结果(tsugu 兼容)
 *
 * ID 字段可传数字或字符串 —— 传非数字文本时与 `text` 等价(走模糊搜索), 调用方不必
 * 先调 /fuzzySearch、也不必记住每个端点各自的字段名。多个字段同时给定时按上述优先级
 * 取用(不再报 422); 一个都没有时返回 undefined, 由调用方决定报错还是走默认行为。
 */
export function pickEntityInput(body: unknown, idKeys: readonly string[] = []): EntityInput | undefined {
    const b = (body ?? {}) as Record<string, unknown>;
    for (const key of ['id', ...idKeys]) {
        const value = b[key];
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'string' && value !== '') return value;
    }
    if (typeof b.text === 'string' && b.text !== '') return b.text;
    const fuzzy = b.fuzzySearchResult;
    if (fuzzy !== null && typeof fuzzy === 'object') return fuzzy as FuzzySearchResult;
    return undefined;
}

function imageBufferToBase64(buffer: Buffer): string {
    return buffer.toString('base64');
}

export function listToBase64(list: Array<Buffer | string>): Array<{ type: 'string' | 'base64', string: string }> {
    if (!list) {
        return [];
    }
    const result: Array<{ type: 'string' | 'base64', string: string }> = [];

    for (let i = 0; i < list.length; i++) {
        parseMessage(list[i]);
    }
    function parseMessage(message: Buffer | string) {
        if (typeof message == 'string') {
            result.push({
                type: 'string',
                string: message
            });
        }
        else if (message instanceof Buffer) {
            result.push({
                type: 'base64',
                string: imageBufferToBase64(message)
            });
        }
    }

    return result;
}
