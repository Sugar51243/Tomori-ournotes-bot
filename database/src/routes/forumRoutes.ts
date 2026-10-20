import { reqStr, optStrKeepEmpty, rawStr, reqInt, optInt, reqEnum, optBool } from '../http/validate';
import { POST_SORTS, type PostSort } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/forum';

/** 论坛模块。行 -> 视图模型的翻译在 web 侧, 这里返回 SQL 原始行。 */
export const forumOps: OpTable = {
    // ---- 板块 ----
    listBoards: async () => repo.listBoards(),
    getBoardBySlug: async p => repo.getBoardBySlug(reqStr(p, 'slug', { max: 32 })) ?? null,
    getBoardById: async p => repo.getBoardById(reqInt(p, 'id', { min: 1 })) ?? null,
    boardStats: async () => repo.boardStats(),

    // ---- 帖子 ----
    listPosts: async p => repo.listPosts({
        boardId: optInt(p, 'boardId', { min: 1 }),
        sort: reqEnum<PostSort>(p, 'sort', POST_SORTS, { def: 'new' }),
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
        viewerId: optInt(p, 'viewerId', { min: 1 }),
    }),

    getPostRow: async p => repo.getPostRow(reqInt(p, 'id', { min: 1 })) ?? null,

    getPostDetail: async p => repo.getPostDetail(reqInt(p, 'id', { min: 1 }), optInt(p, 'viewerId', { min: 1 })) ?? null,

    incrementViewCount: async p => {
        await repo.incrementViewCount(reqInt(p, 'id', { min: 1 }));
        return { ok: true };
    },

    createPost: async p => {
        const id = await repo.createPost({
            boardId: reqInt(p, 'boardId', { min: 1 }),
            authorId: reqInt(p, 'authorId', { min: 1 }),
            title: rawStr(p, 'title', { max: 120 }),
            content: rawStr(p, 'content'),
        });
        return { id };
    },

    updatePost: async p => {
        const fields: { title?: string; content?: string } = {};
        const title = optStrKeepEmpty(p, 'title', { max: 120 });
        const content = optStrKeepEmpty(p, 'content');
        if (title !== undefined) fields.title = title;
        if (content !== undefined) fields.content = content;
        await repo.updatePost(reqInt(p, 'id', { min: 1 }), fields);
        return { ok: true };
    },

    softDeletePost: async p => ({
        deleted: await repo.softDeletePost(reqInt(p, 'id', { min: 1 }), reqInt(p, 'byUserId', { min: 1 })),
    }),

    setPostFlags: async p => {
        const flags: { isPinned?: boolean; isLocked?: boolean } = {};
        if (p.isPinned !== undefined) flags.isPinned = optBool(p, 'isPinned');
        if (p.isLocked !== undefined) flags.isLocked = optBool(p, 'isLocked');
        await repo.setPostFlags(reqInt(p, 'id', { min: 1 }), flags);
        return { ok: true };
    },

    searchPosts: async p => repo.searchPosts({
        like: rawStr(p, 'like', { max: 128 }),
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
        viewerId: optInt(p, 'viewerId', { min: 1 }),
    }),

    /** 正文里是否还有某个片段(上传媒体的清理判定; 片段是文件名, 上限按文件名给足) */
    contentContains: async p => ({
        referenced: await repo.contentContainsFragment(rawStr(p, 'fragment', { max: 128 })),
    }),

    listPostsByAuthor: async p => repo.listPostsByAuthor({
        authorId: reqInt(p, 'authorId', { min: 1 }),
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
        viewerId: optInt(p, 'viewerId', { min: 1 }),
    }),

    countUserActivity: async p => repo.countUserActivity(reqInt(p, 'userId', { min: 1 })),

    listPostsForAdmin: async p => repo.listPostsForAdmin({
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
    }),

    // ---- 评论 ----
    listComments: async p => repo.listComments(reqInt(p, 'postId', { min: 1 }), optInt(p, 'viewerId', { min: 1 })),

    createComment: async p => {
        const id = await repo.createComment({
            postId: reqInt(p, 'postId', { min: 1 }),
            authorId: reqInt(p, 'authorId', { min: 1 }),
            parentId: optInt(p, 'parentId', { min: 1 }),
            content: rawStr(p, 'content'),
        });
        return { id };
    },

    getCommentRow: async p => repo.getCommentRow(reqInt(p, 'id', { min: 1 })) ?? null,

    softDeleteComment: async p => ({
        deleted: await repo.softDeleteComment(reqInt(p, 'id', { min: 1 }), reqInt(p, 'byUserId', { min: 1 })),
    }),

    // ---- 点赞 ----
    toggleLike: async p => repo.toggleLike(
        reqInt(p, 'userId', { min: 1 }),
        reqEnum(p, 'targetType', ['post', 'comment'] as const),
        reqInt(p, 'targetId', { min: 1 })
    ),
};
