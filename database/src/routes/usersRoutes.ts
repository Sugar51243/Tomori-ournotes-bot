import { AppError } from '../http/errors';
import { reqStr, optStr, optRawStr, reqInt, optInt, reqEnum, reqIntArr, rawStr } from '../http/validate';
import { ROLES, type Role } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/users';

/** web_users 的读写。消费方是 web(它的会话微缓存留在 web 侧)。 */
export const usersOps: OpTable = {
    findById: async p => repo.findById(reqInt(p, 'id', { min: 1 })) ?? null,

    findByUsername: async p => repo.findByUsername(reqStr(p, 'username', { max: 32 })) ?? null,

    searchUsers: async p => repo.searchUsers({
        like: rawStr(p, 'like', { max: 128 }),
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
    }),

    findManyByIds: async p => repo.findManyByIds(reqIntArr(p, 'ids', { max: 500 })),

    usernameExists: async p => repo.usernameExists(reqStr(p, 'username', { max: 32 })),

    createUser: async p => {
        const id = await repo.createUser({
            username: reqStr(p, 'username', { max: 32 }),
            nickname: reqStr(p, 'nickname', { max: 32 }),
            passwordHash: reqStr(p, 'passwordHash', { max: 255 }),
            role: p.role === undefined ? undefined : reqEnum(p, 'role', ROLES),
            avatarUrl: optStr(p, 'avatarUrl', { max: 512 }),
        });
        return { id };
    },

    touchLastLogin: async p => {
        await repo.touchLastLogin(reqInt(p, 'id', { min: 1 }));
        return { ok: true };
    },

    updateProfileFields: async p => {
        const profile = p.profile;
        if (profile !== undefined && (typeof profile !== 'object' || profile === null || Array.isArray(profile))) {
            throw AppError.validation('profile 必须是 JSON 对象');
        }
        await repo.updateProfileFields(reqInt(p, 'id', { min: 1 }), {
            nickname: optRawStr(p, 'nickname', { max: 32 }),
            // 显式 null = 清空头像; 缺省 = 不动
            avatarUrl: p.avatarUrl === null ? null : optStr(p, 'avatarUrl', { max: 512 }),
            profile: profile as Record<string, unknown> | undefined,
        });
        return { ok: true };
    },

    updatePassword: async p => {
        await repo.updatePassword(reqInt(p, 'id', { min: 1 }), reqStr(p, 'passwordHash', { max: 255 }));
        return { ok: true };
    },

    bumpTokenVersion: async p => {
        await repo.bumpTokenVersion(reqInt(p, 'id', { min: 1 }));
        return { ok: true };
    },

    setRole: async p => {
        await repo.setRole(reqInt(p, 'id', { min: 1 }), reqEnum<Role>(p, 'role', ROLES));
        return { ok: true };
    },

    setStatus: async p => {
        const status = reqEnum(p, 'status', ['active', 'banned'] as const);
        const reason = p.reason === null ? null : optStr(p, 'reason', { max: 255 });
        await repo.setStatus(reqInt(p, 'id', { min: 1 }), status, reason);
        return { ok: true };
    },

    countByRole: async p => repo.countByRole(reqEnum<Role>(p, 'role', ROLES)),

    listUsers: async p => repo.listUsers({
        q: optStr(p, 'q', { max: 64 }),
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
    }),
};
