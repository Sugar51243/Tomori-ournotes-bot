import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute, withTransaction } from '../mysql';
import type { PostSort } from '../../constants';

/**
 * 论坛读写(SQL 原样搬自 web/server/src/db/repos/forumRepo.ts)。
 * 作者信息一律 JOIN web_users 现取 —— 昵称/头像会变, 冗余存一份在帖子上迟早会与资料对不上。
 *
 * 删除全部是软删(status=0 + deleted_by/deleted_at): 管理动作要留痕, 而且误删还能恢复。
 * 所有列表查询都带 `status = 1`。
 *
 * 行 -> PostListItem/CommentItem 的字段翻译留在 web 侧(toListItem), 这里返回 SQL 原始行。
 */

/** 排序只能来自这份白名单 —— 它是拼进 SQL 的, 不能接受任何用户输入 */
const SORT_SQL: Record<PostSort, string> = {
    new: 'p.last_activity_at DESC, p.id DESC',
    hot: '(p.like_count * 2 + p.comment_count * 3) DESC, p.last_activity_at DESC',
    top: 'p.like_count DESC, p.last_activity_at DESC',
};

/** 列表不拉正文全文, 只取前 240 字做摘要 —— 一页 20 条全文会很浪费 */
const LIST_COLUMNS = `p.id, p.board_id AS boardId, b.slug AS boardSlug, b.name AS boardName,
    p.author_id AS authorId, u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole,
    p.title, LEFT(p.content, 240) AS excerpt,
    p.is_pinned, p.is_locked, p.view_count AS viewCount, p.like_count AS likeCount, p.comment_count AS commentCount,
    p.created_at, p.last_activity_at, (l.user_id IS NOT NULL) AS liked`;

const LIST_JOINS = `FROM web_forum_posts p
    JOIN web_forum_boards b ON b.id = p.board_id
    JOIN web_users u ON u.id = p.author_id
    LEFT JOIN web_likes l ON l.user_id = ? AND l.target_type = 'post' AND l.target_id = p.id`;

// ---------------- 板块 ----------------

export async function listBoards(): Promise<RowDataPacket[]> {
    return query('SELECT * FROM web_forum_boards WHERE is_hidden = 0 ORDER BY sort_order, id');
}

export async function getBoardBySlug(slug: string): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_forum_boards WHERE slug = ?', [slug]);
}

export async function getBoardById(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_forum_boards WHERE id = ?', [id]);
}

/** 板块列表页要显示每个板块的帖子数与最后更新; 返回原始聚合行(board_id / n / last_at) */
export async function boardStats(): Promise<RowDataPacket[]> {
    return query(
        `SELECT board_id, COUNT(*) AS n, MAX(last_activity_at) AS last_at
         FROM web_forum_posts WHERE status = 1 GROUP BY board_id`
    );
}

// ---------------- 帖子 ----------------

export async function listPosts(opts: {
    boardId?: number;
    sort: PostSort;
    offset: number;
    limit: number;
    viewerId?: number;
}): Promise<{ items: RowDataPacket[]; total: number }> {
    const viewer = opts.viewerId ?? 0;
    const where = ['p.status = 1'];
    const filterArgs: unknown[] = [];
    if (opts.boardId !== undefined) {
        where.push('p.board_id = ?');
        filterArgs.push(opts.boardId);
    }
    const clause = `WHERE ${where.join(' AND ')}`;

    const rows = await query(
        `SELECT ${LIST_COLUMNS} ${LIST_JOINS} ${clause}
         ORDER BY p.is_pinned DESC, ${SORT_SQL[opts.sort]}
         LIMIT ? OFFSET ?`,
        [viewer, ...filterArgs, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM web_forum_posts p ${clause}`,
        filterArgs
    );
    return { items: rows, total: Number(totalRow?.n ?? 0) };
}

export async function getPostRow(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_forum_posts WHERE id = ? AND status = 1', [id]);
}

export async function getPostDetail(id: number, viewerId?: number): Promise<RowDataPacket | undefined> {
    const rows = await query(
        `SELECT ${LIST_COLUMNS.replace('LEFT(p.content, 240) AS excerpt', 'p.content')} ${LIST_JOINS}
         WHERE p.id = ? AND p.status = 1`,
        [viewerId ?? 0, id]
    );
    return rows[0];
}

/** 浏览计数: 直接自增, 不做去重(论坛不需要精确的 UV) */
export async function incrementViewCount(id: number): Promise<void> {
    await execute('UPDATE web_forum_posts SET view_count = view_count + 1 WHERE id = ?', [id]);
}

export async function createPost(input: { boardId: number; authorId: number; title: string; content: string }): Promise<number> {
    const result = await execute(
        `INSERT INTO web_forum_posts (board_id, author_id, title, content, last_activity_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [input.boardId, input.authorId, input.title, input.content]
    );
    return result.insertId;
}

export async function updatePost(id: number, fields: { title?: string; content?: string }): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.title !== undefined) {
        sets.push('title = ?');
        args.push(fields.title);
    }
    if (fields.content !== undefined) {
        sets.push('content = ?');
        args.push(fields.content);
    }
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_forum_posts SET ${sets.join(', ')} WHERE id = ? AND status = 1`, args);
}

export async function softDeletePost(id: number, byUserId: number): Promise<boolean> {
    const result = await execute(
        'UPDATE web_forum_posts SET status = 0, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 1',
        [byUserId, id]
    );
    return result.affectedRows > 0;
}

export async function setPostFlags(id: number, flags: { isPinned?: boolean; isLocked?: boolean }): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (flags.isPinned !== undefined) {
        sets.push('is_pinned = ?');
        args.push(flags.isPinned ? 1 : 0);
    }
    if (flags.isLocked !== undefined) {
        sets.push('is_locked = ?');
        args.push(flags.isLocked ? 1 : 0);
    }
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_forum_posts SET ${sets.join(', ')} WHERE id = ?`, args);
}

/**
 * 帖子搜索(标题 + 正文)。
 *
 * 用的是 `LIKE '%词%'` —— 前导通配符用不上索引, 数据量大了会全表扫。
 * 搜索词由调用方先过 escapeLike, 否则一个 % 就等于全量返回。
 */
export async function searchPosts(opts: {
    like: string;
    limit: number;
    viewerId?: number;
}): Promise<RowDataPacket[]> {
    return query(
        `SELECT ${LIST_COLUMNS} ${LIST_JOINS}
         WHERE p.status = 1 AND (p.title LIKE ? OR p.content LIKE ?)
         ORDER BY p.is_pinned DESC, p.last_activity_at DESC
         LIMIT ?`,
        [opts.viewerId ?? 0, opts.like, opts.like, opts.limit]
    );
}

/**
 * 未删除的帖子/评论正文里是否出现过某个片段(论坛上传媒体的"还有没有人引用"判定用)。
 * 片段来自磁盘文件名(我们自己生成的内容哈希), 但 LIKE 通配符仍然转义 —— 这一层该做的事。
 */
export async function contentContainsFragment(fragment: string): Promise<boolean> {
    const like = `%${fragment.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    const row = await queryOne<{ n: number }>(
        `SELECT
            (SELECT COUNT(*) FROM web_forum_posts WHERE status = 1 AND content LIKE ?) +
            (SELECT COUNT(*) FROM web_forum_comments WHERE status = 1 AND content LIKE ?) AS n`,
        [like, like]
    );
    return Number(row?.n ?? 0) > 0;
}

/** 某个作者的帖子(个人主页用) */
export async function listPostsByAuthor(opts: {
    authorId: number;
    offset: number;
    limit: number;
    viewerId?: number;
}): Promise<{ items: RowDataPacket[]; total: number }> {
    const rows = await query(
        `SELECT ${LIST_COLUMNS} ${LIST_JOINS}
         WHERE p.status = 1 AND p.author_id = ?
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
        [opts.viewerId ?? 0, opts.authorId, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM web_forum_posts WHERE status = 1 AND author_id = ?',
        [opts.authorId]
    );
    return { items: rows, total: Number(totalRow?.n ?? 0) };
}

/** 个人主页的活跃度统计 */
export async function countUserActivity(userId: number): Promise<{ posts: number; comments: number }> {
    const row = await queryOne<{ posts: number; comments: number }>(
        `SELECT
            (SELECT COUNT(*) FROM web_forum_posts WHERE author_id = ? AND status = 1)    AS posts,
            (SELECT COUNT(*) FROM web_forum_comments WHERE author_id = ? AND status = 1) AS comments`,
        [userId, userId]
    );
    return { posts: Number(row?.posts ?? 0), comments: Number(row?.comments ?? 0) };
}

/** 管理后台的跨板块列表(不过滤板块, 但要能筛出已被删的) */
export async function listPostsForAdmin(opts: { offset: number; limit: number }): Promise<{ items: RowDataPacket[]; total: number }> {
    const rows = await query(
        `SELECT ${LIST_COLUMNS} ${LIST_JOINS} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
        [0, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM web_forum_posts');
    return { items: rows, total: Number(totalRow?.n ?? 0) };
}

// ---------------- 评论 ----------------

export async function listComments(postId: number, viewerId?: number): Promise<RowDataPacket[]> {
    return query(
        `SELECT c.id, c.post_id AS postId, c.parent_id AS parentId, c.author_id AS authorId,
                u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole,
                c.content, c.like_count AS likeCount, c.created_at AS createdAt,
                (l.user_id IS NOT NULL) AS liked
         FROM web_forum_comments c
         JOIN web_users u ON u.id = c.author_id
         LEFT JOIN web_likes l ON l.user_id = ? AND l.target_type = 'comment' AND l.target_id = c.id
         WHERE c.post_id = ? AND c.status = 1
         ORDER BY c.created_at, c.id`,
        [viewerId ?? 0, postId]
    );
}

export async function createComment(input: { postId: number; authorId: number; parentId?: number; content: string }): Promise<number> {
    // 评论插入与帖子计数必须一起成功, 否则 comment_count 会飘
    return withTransaction(async conn => {
        const [result] = await conn.query(
            'INSERT INTO web_forum_comments (post_id, parent_id, author_id, content) VALUES (?, ?, ?, ?)',
            [input.postId, input.parentId ?? null, input.authorId, input.content]
        );
        const insertId = (result as { insertId: number }).insertId;
        await conn.query(
            `UPDATE web_forum_posts
             SET comment_count = comment_count + 1, last_activity_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [input.postId]
        );
        return insertId;
    });
}

export async function getCommentRow(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_forum_comments WHERE id = ? AND status = 1', [id]);
}

export async function softDeleteComment(id: number, byUserId: number): Promise<boolean> {
    return withTransaction(async conn => {
        const [rows] = await conn.query('SELECT post_id FROM web_forum_comments WHERE id = ? AND status = 1', [id]);
        const postId = (rows as Array<{ post_id: number }>)[0]?.post_id;
        if (postId === undefined) return false;

        await conn.query(
            'UPDATE web_forum_comments SET status = 0, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
            [byUserId, id]
        );
        await conn.query(
            'UPDATE web_forum_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ?',
            [postId]
        );
        return true;
    });
}

// ---------------- 点赞 ----------------

const LIKE_TABLES = {
    post: 'web_forum_posts',
    comment: 'web_forum_comments',
} as const;

export type LikeTarget = keyof typeof LIKE_TABLES;

export async function toggleLike(userId: number, targetType: LikeTarget, targetId: number): Promise<{ liked: boolean; count: number }> {
    const table = LIKE_TABLES[targetType];
    return withTransaction(async conn => {
        // 先删: 删到了说明本来就是点赞状态, 这次是取消
        const [del] = await conn.query(
            'DELETE FROM web_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
            [userId, targetType, targetId]
        );
        const removed = (del as { affectedRows: number }).affectedRows > 0;

        if (removed) {
            await conn.query(`UPDATE ${table} SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?`, [targetId]);
        } else {
            await conn.query('INSERT INTO web_likes (user_id, target_type, target_id) VALUES (?, ?, ?)', [
                userId,
                targetType,
                targetId,
            ]);
            await conn.query(`UPDATE ${table} SET like_count = like_count + 1 WHERE id = ?`, [targetId]);
        }

        const [rows] = await conn.query(`SELECT like_count FROM ${table} WHERE id = ?`, [targetId]);
        const count = (rows as Array<{ like_count: number }>)[0]?.like_count ?? 0;
        return { liked: !removed, count: Number(count) };
    });
}
