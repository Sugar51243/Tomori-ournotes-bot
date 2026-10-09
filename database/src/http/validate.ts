import { AppError } from './errors';

/**
 * 轻量参数校验: 出错立刻抛 AppError(400), 由 errorHandler 统一出口。
 * 与 web/server 的同名模块同款, 但这里的 body 就是 op 参数对象本身。
 */

type Body = Record<string, unknown> | undefined;

function label(field: string, alias?: string): string {
    return alias ?? field;
}

export function reqStr(body: Body, field: string, opts: { min?: number; max?: number; alias?: string } = {}): string {
    const raw = body?.[field];
    if (typeof raw !== 'string') throw AppError.validation(`缺少字段 ${label(field, opts.alias)}`);
    const v = raw;
    const min = opts.min ?? 1;
    if (v.trim().length < min) throw AppError.validation(`${label(field, opts.alias)}不能为空`);
    if (opts.max !== undefined && v.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 个字符`);
    }
    return v;
}

/** 必填字符串但保留原样(不 trim) —— 关键词这类内容前后空格是否算数由调用方决定 */
export function rawStr(body: Body, field: string, opts: { max?: number; alias?: string } = {}): string {
    const raw = body?.[field];
    if (typeof raw !== 'string') throw AppError.validation(`缺少字段 ${label(field, opts.alias)}`);
    if (opts.max !== undefined && raw.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 个字符`);
    }
    return raw;
}

/** 可选的「不 trim」字符串(需要原样落库的展示类字段用; 空串 → undefined) */
export function optRawStr(body: Body, field: string, opts: { max?: number; alias?: string } = {}): string | undefined {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') throw AppError.validation(`${label(field, opts.alias)}必须是文本`);
    if (opts.max !== undefined && raw.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 个字符`);
    }
    return raw;
}

/**
 * 可选字符串, 但**空串是合法值**(编辑正文这类字段: 传了 '' 就是要写 '');
 * 只有 undefined/null 才算"字段缺省不改"。
 */
export function optStrKeepEmpty(body: Body, field: string, opts: { max?: number; alias?: string } = {}): string | undefined {
    const raw = body?.[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') throw AppError.validation(`${label(field, opts.alias)}必须是文本`);
    if (opts.max !== undefined && raw.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 个字符`);
    }
    return raw;
}

export function optStr(body: Body, field: string, opts: { max?: number; alias?: string } = {}): string | undefined {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') throw AppError.validation(`${label(field, opts.alias)}必须是文本`);
    if (opts.max !== undefined && raw.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 个字符`);
    }
    return raw;
}

export function reqInt(body: Body, field: string, opts: { min?: number; max?: number; alias?: string } = {}): number {
    const raw = body?.[field];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw AppError.validation(`${label(field, opts.alias)}必须是整数`);
    }
    if (opts.min !== undefined && n < opts.min) throw AppError.validation(`${label(field, opts.alias)}不能小于 ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw AppError.validation(`${label(field, opts.alias)}不能大于 ${opts.max}`);
    return n;
}

export function optInt(body: Body, field: string, opts: { min?: number; max?: number; def?: number; alias?: string } = {}): number | undefined {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return opts.def;
    return reqInt(body, field, opts);
}

/** 数字但不要求整数(分数/比率用) */
export function reqNum(body: Body, field: string, opts: { min?: number; max?: number; alias?: string } = {}): number {
    const raw = body?.[field];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw AppError.validation(`${label(field, opts.alias)}必须是数字`);
    }
    if (opts.min !== undefined && n < opts.min) throw AppError.validation(`${label(field, opts.alias)}不能小于 ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw AppError.validation(`${label(field, opts.alias)}不能大于 ${opts.max}`);
    return n;
}

export function optBool(body: Body, field: string, def = false): boolean {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return def;
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === 'false' || raw === '0' || raw === 0) return false;
    throw AppError.validation(`${field} 必须是布尔值`);
}

export function reqEnum<T extends string>(body: Body, field: string, allowed: readonly T[], opts: { def?: T; alias?: string } = {}): T {
    const raw = body?.[field];
    if ((raw === undefined || raw === null || raw === '') && opts.def !== undefined) return opts.def;
    if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
        throw AppError.validation(`${label(field, opts.alias)}必须是 ${allowed.join(' / ')} 之一`);
    }
    return raw as T;
}

export function reqArr(body: Body, field: string, opts: { min?: number; max?: number; alias?: string } = {}): unknown[] {
    const raw = body?.[field];
    if (!Array.isArray(raw)) throw AppError.validation(`缺少字段 ${label(field, opts.alias)}(应为数组)`);
    const min = opts.min ?? 0;
    if (raw.length < min) throw AppError.validation(`${label(field, opts.alias)}至少 ${min} 项`);
    if (opts.max !== undefined && raw.length > opts.max) {
        throw AppError.validation(`${label(field, opts.alias)}最多 ${opts.max} 项`);
    }
    return raw;
}

/** 日期参数(消费方传 ISO 字符串或毫秒数); 返回 Date 供 mysql2 正确格式化 */
export function reqDate(body: Body, field: string, opts: { alias?: string } = {}): Date {
    const raw = body?.[field];
    const ms = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) throw AppError.validation(`${label(field, opts.alias)}必须是合法时间`);
    return new Date(ms);
}

/** 正整数数组(IN 查询/批量 id 用) */
export function reqIntArr(body: Body, field: string, opts: { max?: number; alias?: string } = {}): number[] {
    const arr = reqArr(body, field, opts);
    return arr.map(v => {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
            throw AppError.validation(`${label(field, opts.alias)}必须是正整数数组`);
        }
        return n;
    });
}

/** 可空的整数字段(MySQL 的 BIGINT NULL): 缺省 / null / '' 都视作 null */
export function optIntOrNull(body: Body, field: string, opts: { alias?: string } = {}): number | null {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw AppError.validation(`${label(field, opts.alias)}必须是整数或 null`);
    }
    return n;
}
