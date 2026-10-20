import { reqStr, optStr, rawStr, reqInt, optInt, optBool, reqNum } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/stations';

/** 车站模块(bot 与 web 共用同一个 stations 集合; expireAt 由服务端按 STATION_TTL_S 计算)。 */
export const stationsOps: OpTable = {
    listActive: async () => repo.listActive(),

    search: async p => repo.search(
        rawStr(p, 'pattern', { max: 64 }),
        optInt(p, 'numeric', { min: 1 }),
        reqInt(p, 'limit', { min: 1, max: 100 })
    ),

    submit: async p => {
        await repo.submit({
            number: reqInt(p, 'number', { min: 1, max: 99_999_999 }),
            rawMessage: rawStr(p, 'rawMessage', { max: 500 }),
            source: reqStr(p, 'source', { max: 32 }),
            userId: reqStr(p, 'userId', { max: 32 }),
            userName: rawStr(p, 'userName', { max: 64 }),
            time: reqNum(p, 'time'),
            timeMs: reqNum(p, 'timeMs'),
            avatarUrl: optStr(p, 'avatarUrl', { max: 512 }),
        }, optBool(p, 'claim', false));
        return { ok: true };
    },

    deleteOwned: async p => ({
        deleted: await repo.deleteOwned(
            reqInt(p, 'number', { min: 1, max: 99_999_999 }),
            reqStr(p, 'userId', { max: 32 }),
            optBool(p, 'force', false)
        ),
    }),
};
