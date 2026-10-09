import { reqStr, optStr, reqInt } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/bindings';

/** 玩家绑定模块(bot 的 QQ ↔ 游戏账号绑定; 一个 QQ 可绑多个账号)。 */
export const bindingsOps: OpTable = {
    add: async p => {
        await repo.add({
            userId: reqStr(p, 'userId', { max: 32 }),
            accountId: reqInt(p, 'accountId', { min: 1 }),
            playerId: reqStr(p, 'playerId', { max: 15 }),
            server: reqStr(p, 'server', { max: 16 }),
            label: optStr(p, 'label', { max: 32 }),
        });
        return { ok: true };
    },

    list: async p => repo.list(reqStr(p, 'userId', { max: 32 })),

    /** 没有绑定 = data 为 null; 集合不可用会走 DB_UNAVAILABLE 错误 —— 两者由调用方区分 */
    getDefault: async p => repo.getDefault(reqStr(p, 'userId', { max: 32 })),

    remove: async p => ({
        removed: await repo.remove(reqStr(p, 'userId', { max: 32 }), reqInt(p, 'accountId', { min: 1 })),
    }),

    setDefault: async p => ({
        updated: await repo.setDefault(reqStr(p, 'userId', { max: 32 }), reqInt(p, 'accountId', { min: 1 })),
    }),
};
