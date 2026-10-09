import { reqStr, rawStr, reqInt, optInt, reqEnum, reqDate, optStr } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/chat';

/** 沙盒聊天室模块(SQL 原样搬自 web 的 chatRepo)。 */
export const chatOps: OpTable = {
    ensurePrivateRoom: async p => repo.ensurePrivateRoom(
        reqInt(p, 'userId', { min: 1 }),
        rawStr(p, 'title', { max: 64 })
    ),

    getRoom: async p => repo.getRoom(reqInt(p, 'id', { min: 1 })) ?? null,

    listMessages: async p => repo.listMessages(reqInt(p, 'roomId', { min: 1 }), {
        limit: reqInt(p, 'limit', { min: 1, max: 200 }),
        beforeId: optInt(p, 'beforeId', { min: 1 }),
    }),

    insertMessage: async p => repo.insertMessage({
        roomId: reqInt(p, 'roomId', { min: 1 }),
        authorId: p.authorId === null ? null : reqInt(p, 'authorId', { min: 1 }),
        kind: reqEnum(p, 'kind', ['text', 'result', 'error'] as const),
        content: rawStr(p, 'content'),
        attachment: optStr(p, 'attachment', { max: 160 }),
    }),

    clearMessages: async p => ({ removed: await repo.clearMessages(reqInt(p, 'roomId', { min: 1 })) }),

    findOldAttachments: async p => repo.findOldAttachments(reqDate(p, 'olderThan')),
};
