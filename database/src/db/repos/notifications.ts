import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';

/**
 * 用户通知（论坛里被艾特 / 被回复）。
 *
 * ⚠ 与本文件的 `notices.ts` **不是一回事**：那个是管理员发的站内公告（web_notices），
 * 这个是发给某个用户个人的提醒。命名上刻意分开，别混。
 *
 * 「一条信息只发一次通知」由表上的 `uniq_source (user_id, post_id, comment_id)` 唯一键兜底 ——
 * 同一条评论里既 @ 了某人又回复了同一人时，两条写入路径撞在同一个键上，只留一条。
 * 为什么不用「先查再插」：并发与失败重试都会漏，唯一键才是唯一可靠的做法。
 */

export type NotificationKind = 'mention' | 'reply';

/**
 * 列表要显示「谁、在哪个帖子、什么事」，所以触发者与帖子都是**读时 JOIN** 出来的
 * （与 listComments 同一套写法：作者信息从不冗余存储，昵称改了通知里就跟着变）。
 * `postStatus` / `commentStatus` 一并带出来：被软删之后界面要说一声，
 * 而不是给个点进去 404 的链接。
 */
const LIST_COLUMNS = `
    n.id, n.kind, n.post_id AS postId, n.comment_id AS commentId, n.is_read AS isRead, n.created_at AS createdAt,
    u.id AS actorId, u.nickname AS actorNickname, u.avatar_url AS actorAvatar, u.role AS actorRole,
    p.title AS postTitle, p.status AS postStatus, c.status AS commentStatus`;

/**
 * 写一条通知；已经有同源通知时返回 false（什么也没写）。
 *
 * **「有没有重复」不能看 INSERT 的 affectedRows**：mysql2 默认带 `CLIENT_FOUND_ROWS`
 * （见 node_modules/mysql2/lib/connection_config.js 的默认 flags），于是
 * `ON DUPLICATE KEY UPDATE id = id` 命中已有行时 affectedRows 也是 **1** 而不是 0 ——
 * 拿它当"插入成功"会让 `created` 永远是 true（踩过，实测）。
 * 也不用 `INSERT IGNORE`：那会把超长/类型不对之类的错误一起吞掉，只想忽略"重复"这一种。
 *
 * 所以先按唯一键查一次。真正的保证仍然在**唯一键**上：并发下这里可能两个都返回 true，
 * 但绝不会多出一行 —— 这个返回值只是给日志和调用方看的，不承担正确性。
 */
export async function createNotification(input: {
    userId: number;
    actorId: number;
    kind: NotificationKind;
    postId: number;
    /** 0 = 这条通知对应的是帖子本身 */
    commentId: number;
}): Promise<boolean> {
    const existing = await queryOne<{ id: number }>(
        'SELECT id FROM web_notifications WHERE user_id = ? AND post_id = ? AND comment_id = ?',
        [input.userId, input.postId, input.commentId]
    );
    if (existing) return false;

    await execute(
        `INSERT INTO web_notifications (user_id, actor_id, kind, post_id, comment_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [input.userId, input.actorId, input.kind, input.postId, input.commentId]
    );
    return true;
}

export async function listNotifications(opts: {
    userId: number;
    limit: number;
    offset: number;
}): Promise<{ items: RowDataPacket[]; total: number; unread: number }> {
    // ⚠ 这里**只按 user_id 过滤，绝不加 status 条件**。过滤条件的后果是：
    // 未读数把这些行算进去、列表却把它们藏起来 —— 用户看到红点写着 3、列表只有 2 条，
    // 点「一键已读」红点清零却又对不上账。要显示「已删除」，不要把它们筛掉。
    // 因此触发者与帖子/评论一律 LEFT JOIN：INNER JOIN 会让少一行的那条通知整个消失。
    const items = await query(
        `SELECT ${LIST_COLUMNS}
         FROM web_notifications n
         LEFT JOIN web_users u ON u.id = n.actor_id
         LEFT JOIN web_forum_posts p ON p.id = n.post_id
         LEFT JOIN web_forum_comments c ON c.id = n.comment_id
         WHERE n.user_id = ?
         ORDER BY n.id DESC
         LIMIT ? OFFSET ?`,
        [opts.userId, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM web_notifications WHERE user_id = ?', [opts.userId]);
    const unreadRow = await queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM web_notifications WHERE user_id = ? AND is_read = 0',
        [opts.userId]
    );
    return { items, total: Number(totalRow?.n ?? 0), unread: Number(unreadRow?.n ?? 0) };
}

/** 未读数：顶栏红点就靠它，轮询很频繁，所以单查一次 COUNT 别的都不带 */
export async function countUnread(userId: number): Promise<number> {
    const row = await queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM web_notifications WHERE user_id = ? AND is_read = 0',
        [userId]
    );
    return Number(row?.n ?? 0);
}

/** 标记若干条已读；返回实际改动的条数 */
export async function markRead(userId: number, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    // `user_id = ?` 必须一起进 WHERE：只按 id 改会让人能标记别人的通知
    const result = await execute(
        `UPDATE web_notifications SET is_read = 1
         WHERE user_id = ? AND is_read = 0 AND id IN (${ids.map(() => '?').join(',')})`,
        [userId, ...ids]
    );
    return result.affectedRows;
}

/** 一键已读 */
export async function markAllRead(userId: number): Promise<number> {
    const result = await execute('UPDATE web_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
    return result.affectedRows;
}
