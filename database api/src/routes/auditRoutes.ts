import { optStr, rawStr, reqInt, optInt, reqEnum } from '../http/validate';
import { ROLES, type Role } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/audit';

/** 管理审计模块(SQL 原样搬自 web 的 auditRepo); 「失败不抛」的吞错策略留在 web 侧。 */
export const auditOps: OpTable = {
    writeAudit: async p => {
        await repo.writeAudit({
            actorId: reqInt(p, 'actorId', { min: 1 }),
            actorRole: reqEnum<Role>(p, 'actorRole', ROLES),
            action: rawStr(p, 'action', { max: 64 }),
            targetType: rawStr(p, 'targetType', { max: 32 }),
            targetId: optInt(p, 'targetId', { min: 1 }),
            detail: p.detail,
            ip: optStr(p, 'ip', { max: 45 }),
        });
        return { ok: true };
    },

    listAudit: async p => repo.listAudit({
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
        action: optStr(p, 'action', { max: 64 }),
    }),
};
