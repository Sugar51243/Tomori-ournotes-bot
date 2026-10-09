import { reqStr, optStr, rawStr, reqInt, reqEnum, optBool, optIntOrNull } from '../http/validate';
import { normalizeServer, type Server } from '../constants';
import { AppError } from '../http/errors';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/accounts';

/** 账号包模块(SQL 原样搬自 web 的 gameAccountRepo)。 */

function reqServer(p: Record<string, unknown>, field = 'server'): Server {
    const server = normalizeServer(reqStr(p, field, { max: 16 }));
    if (!server) throw AppError.validation(`${field} 不合法`);
    return server;
}

export const accountsOps: OpTable = {
    listByUser: async p => repo.listByUser(reqInt(p, 'userId', { min: 1 })),

    getRow: async p => repo.getRow(reqInt(p, 'id', { min: 1 })) ?? null,

    getDetailCategory: async p => repo.getDetailCategory(
        reqInt(p, 'id', { min: 1 }),
        reqEnum(p, 'category', ['cards', 'items', 'songs'] as const)
    ),

    findByPlayerId: async p => repo.findByPlayerId(
        reqStr(p, 'playerId', { max: 15 }),
        reqServer(p)
    ) ?? null,

    countByUser: async p => repo.countByUser(reqInt(p, 'userId', { min: 1 })),

    upsert: async p => {
        const gameUid = p.gameUid === null ? null : optStr(p, 'gameUid', { max: 24 }) ?? null;
        const masterVersion = p.masterVersion === null ? null : optStr(p, 'masterVersion', { max: 64 }) ?? null;
        if (p.stats === undefined) throw AppError.validation('缺少字段 stats');
        return repo.upsert({
            userId: reqInt(p, 'userId', { min: 1 }),
            gameUid,
            server: reqServer(p),
            packageId: rawStr(p, 'packageId', { max: 64 }),
            playerName: rawStr(p, 'playerName', { max: 64 }),
            masterVersion,
            stats: p.stats,
            cards: p.cards ?? null,
            items: p.items ?? null,
            songs: p.songs ?? null,
        });
    },

    updateVisibility: async p => {
        const fields: Parameters<typeof repo.updateVisibility>[1] = {};
        if (p.showCards !== undefined) fields.showCards = optBool(p, 'showCards');
        if (p.showItems !== undefined) fields.showItems = optBool(p, 'showItems');
        if (p.showSongs !== undefined) fields.showSongs = optBool(p, 'showSongs');
        const label = optStr(p, 'label', { max: 32 });
        if (label !== undefined) fields.label = label;
        if (p.server !== undefined) fields.server = reqServer(p);
        const tgw = optIntOrNull(p, 'tgwCardRank');
        if (p.tgwCardRank !== undefined && tgw !== null) fields.tgwCardRank = tgw;
        // playerId: 显式 null = 清空; 缺省 = 不动
        if (p.playerId === null) fields.playerId = null;
        else if (p.playerId !== undefined) fields.playerId = reqStr(p, 'playerId', { max: 15 });
        await repo.updateVisibility(reqInt(p, 'id', { min: 1 }), fields);
        return { ok: true };
    },

    softDelete: async p => ({ deleted: await repo.softDelete(reqInt(p, 'id', { min: 1 })) }),
};
