import { AppError } from '../http/errors';
import { reqStr, optStr, reqInt, optInt, reqArr, reqEnum } from '../http/validate';
import { isCutoffTier, normalizeServer, type CutoffTier } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/cutoff';
import * as legacyCutoffs from '../db/repos/legacyCutoffs';

/**
 * 榜线模块。写入方是 bot(常驻采样 + SQLite 回灌), 读取方是 bot(出图)与 web(榜线页)。
 */

/** 行数上限: 8MB body 装得下更多, 但单请求工作量要有上界 */
const MAX_ROWS = 10_000;
const MAX_SCAN_LIMIT = 5000;
const DEFAULT_SCAN_LIMIT = 1000;

function reqServer(params: Record<string, unknown>): string {
    const raw = reqStr(params, 'server', { max: 16 });
    const server = normalizeServer(raw);
    if (!server) throw AppError.validation(`server 不合法: ${raw}`);
    return server;
}

/** 游标必须是 [server, eventId, musicId, tier, bucket] 五元组 */
function optCursor(params: Record<string, unknown>): [string, number, number, number, number] | undefined {
    const raw = params.after;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw) || raw.length !== 5) {
        throw AppError.validation('after 必须是 [server, eventId, musicId, tier, bucket] 五元组');
    }
    const [server, eventId, musicId, tier, bucket] = raw as unknown[];
    const nums = [eventId, musicId, tier, bucket].map(Number);
    if (typeof server !== 'string' || nums.some(n => !Number.isFinite(n))) {
        throw AppError.validation('after 的元素类型不合法');
    }
    return [server, nums[0], nums[1], nums[2], nums[3]];
}

function optTiers(params: Record<string, unknown>): CutoffTier[] | undefined {
    const raw = params.tiers;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw AppError.validation('tiers 必须是数组');
    const tiers = raw.map(Number).filter(isCutoffTier);
    return tiers.length ? tiers : undefined;
}

export const cutoffOps: OpTable = {
    ping: async () => {
        await repo.ping();
        return { ok: true };
    },

    upsert: async params => {
        const mode = reqEnum(params, 'mode', ['record', 'merge'] as const);
        const rows = reqArr(params, 'rows', { max: MAX_ROWS });
        return repo.upsertRows(rows, mode);
    },

    load: async params => {
        const server = reqServer(params);
        const eventId = reqInt(params, 'eventId', { min: 0 });
        return repo.load(server, eventId);
    },

    scan: async params => {
        const after = optCursor(params);
        const limit = Math.min(optInt(params, 'limit', { min: 1, def: DEFAULT_SCAN_LIMIT }) ?? DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
        return repo.scan(after, limit);
    },

    metaGet: async params => {
        const key = reqStr(params, 'key', { max: 64 });
        return { value: (await repo.getMeta(key)) ?? null };
    },

    metaSet: async params => {
        const key = reqStr(params, 'key', { max: 64 });
        const value = reqStr(params, 'value', { max: 255 });
        await repo.setMeta(key, value);
        return { ok: true };
    },

    listEvents: async params => {
        const server = reqServer(params);
        const limit = Math.min(optInt(params, 'limit', { min: 1, def: 30 }) ?? 30, 200);
        return repo.listCutoffEvents(server as Parameters<typeof repo.listCutoffEvents>[0], limit);
    },

    series: async params => {
        const server = reqServer(params);
        const eventId = reqInt(params, 'eventId', { min: 0 });
        const tiers = optTiers(params);
        return repo.loadCutoffSeries(server as Parameters<typeof repo.loadCutoffSeries>[0], eventId, tiers);
    },

    /** 旧 Mongo `cutoffs` 集合的分页扫描(bot 一次性迁移用; 只读) */
    legacyScan: async params => {
        const afterId = optStr(params, 'afterId', { max: 64 });
        if (afterId !== undefined && !/^[0-9a-fA-F]{24}$/.test(afterId)) {
            throw AppError.validation('afterId 必须是 ObjectId 十六进制串');
        }
        const limit = Math.min(optInt(params, 'limit', { min: 1, def: 1000 }) ?? 1000, MAX_SCAN_LIMIT);
        return legacyCutoffs.scan(afterId, limit);
    },
};
