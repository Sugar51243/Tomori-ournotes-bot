import { rawStr, optStrKeepEmpty, reqInt, optInt, optBool } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/notices';

/** 网页公告模块(SQL 原样搬自 web 的 noticeRepo)。 */
export const noticesOps: OpTable = {
    listNotices: async p => repo.listNotices({
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
        includeDrafts: optBool(p, 'includeDrafts', false),
    }),

    getNotice: async p => repo.getNotice(reqInt(p, 'id', { min: 1 }), optBool(p, 'includeDrafts', false)) ?? null,

    createNotice: async p => {
        const id = await repo.createNotice({
            title: rawStr(p, 'title', { max: 120 }),
            content: rawStr(p, 'content'),
            authorId: reqInt(p, 'authorId', { min: 1 }),
            publish: optBool(p, 'publish', false),
            pinned: optBool(p, 'pinned', false),
        });
        return { id };
    },

    updateNotice: async p => {
        const fields: { title?: string; content?: string; publish?: boolean; pinned?: boolean } = {};
        const title = optStrKeepEmpty(p, 'title', { max: 120 });
        const content = optStrKeepEmpty(p, 'content');
        if (title !== undefined) fields.title = title;
        if (content !== undefined) fields.content = content;
        if (p.publish !== undefined) fields.publish = optBool(p, 'publish');
        if (p.pinned !== undefined) fields.pinned = optBool(p, 'pinned');
        await repo.updateNotice(reqInt(p, 'id', { min: 1 }), fields);
        return { ok: true };
    },

    deleteNotice: async p => ({ deleted: await repo.deleteNotice(reqInt(p, 'id', { min: 1 })) }),
};
