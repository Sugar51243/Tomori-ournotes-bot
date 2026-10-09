import { reqStr, optStr, rawStr, reqInt } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/friends';

/** 交友模块(bot 与 web 共用同一个 friends 集合)。 */
export const friendsOps: OpTable = {
    list: async () => repo.list(),

    get: async p => repo.get(reqStr(p, 'userId', { max: 32 })),

    upsert: async p => {
        await repo.upsert({
            userId: reqStr(p, 'userId', { max: 32 }),
            userName: rawStr(p, 'userName', { max: 64 }),
            avatarUrl: optStr(p, 'avatarUrl', { max: 512 }),
            playerId: reqStr(p, 'playerId', { max: 15 }),
            server: reqStr(p, 'server', { max: 16 }),
        });
        return { ok: true };
    },

    search: async p => repo.search(
        rawStr(p, 'pattern', { max: 64 }),
        reqInt(p, 'limit', { min: 1, max: 100 })
    ),

    remove: async p => ({ removed: await repo.remove(reqStr(p, 'userId', { max: 32 })) }),
};
