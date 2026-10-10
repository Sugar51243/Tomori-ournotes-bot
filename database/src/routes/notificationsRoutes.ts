import { reqInt, optInt, reqEnum, reqIntArr } from '../http/validate';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/notifications';

/**
 * 用户通知模块（论坛里被艾特 / 被回复）。
 *
 * 这里的 `userId` **由 web 侧从登录态推出来**再传进来 —— 数据库层不认人，
 * 它只负责"给这个用户查/改"；鉴权在 web/server 那层做（见 notificationRoutes.ts）。
 */
export const notificationsOps: OpTable = {
    /** 写一条通知。重复（同一条信息已经通知过这个人）返回 created: false，不算错误 */
    createNotification: async p => ({
        created: await repo.createNotification({
            userId: reqInt(p, 'userId', { min: 1 }),
            actorId: reqInt(p, 'actorId', { min: 1 }),
            kind: reqEnum(p, 'kind', ['mention', 'reply'] as const),
            postId: reqInt(p, 'postId', { min: 1 }),
            commentId: optInt(p, 'commentId', { min: 0 }) ?? 0,
        }),
    }),

    listNotifications: async p =>
        repo.listNotifications({
            userId: reqInt(p, 'userId', { min: 1 }),
            limit: reqInt(p, 'limit', { min: 1, max: 100 }),
            offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        }),

    /** 顶栏轮询用；只回一个数 */
    countUnread: async p => ({ unread: await repo.countUnread(reqInt(p, 'userId', { min: 1 })) }),

    markRead: async p => ({
        changed: await repo.markRead(reqInt(p, 'userId', { min: 1 }), reqIntArr(p, 'ids', { max: 200 })),
    }),

    markAllRead: async p => ({ changed: await repo.markAllRead(reqInt(p, 'userId', { min: 1 })) }),
};
