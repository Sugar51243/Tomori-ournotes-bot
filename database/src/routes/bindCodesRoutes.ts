import { reqInt, reqStr } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/bindCodes';

/** bot 绑定码模块(SQL 原样搬自 web 的 bindRepo); 码的随机生成也在服务端。 */
export const bindCodesOps: OpTable = {
    issueCode: async p => repo.issueCode(
        reqInt(p, 'userId', { min: 1 }),
        reqInt(p, 'accountId', { min: 1 })
    ),

    consumeCode: async p => repo.consumeCode(reqStr(p, 'code', { max: 32 })),

    countByAccount: async p => repo.countByAccount(reqInt(p, 'accountId', { min: 1 })),
};
