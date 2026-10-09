import { reqStr, reqInt, reqArr } from '../http/validate';
import { normalizeServer } from '../constants';
import { AppError } from '../http/errors';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/songCache';

/** 曲名缓存模块(SQL 原样搬自 web 的 songCacheRepo)。 */
export const songCacheOps: OpTable = {
    getCachedTitle: async p => {
        const server = normalizeServer(reqStr(p, 'server', { max: 16 }));
        if (!server) throw AppError.validation('server 不合法');
        return { title: (await repo.getCachedTitle(reqInt(p, 'songId', { min: 1 }), server)) ?? null };
    },

    putCachedTitles: async p => {
        const server = normalizeServer(reqStr(p, 'server', { max: 16 }));
        if (!server) throw AppError.validation('server 不合法');
        const entries = reqArr(p, 'entries', { max: 500 }).map(raw => {
            const e = raw as { songId?: unknown; title?: unknown };
            const songId = Number(e?.songId);
            if (!Number.isInteger(songId) || songId <= 0 || typeof e?.title !== 'string' || e.title.length > 255) {
                throw AppError.validation('entries 的每一项必须是 {songId, title}');
            }
            return { songId, title: e.title };
        });
        await repo.putCachedTitles(server, entries);
        return { ok: true };
    },
};
