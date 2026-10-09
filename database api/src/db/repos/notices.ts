import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';

/**
 * 网页公告(SQL 原样搬自 web/server/src/db/repos/noticeRepo.ts)。
 * status: 0 = 草稿, 1 = 已发布。游客只看得到已发布的。
 */

export async function listNotices(opts: { offset: number; limit: number; includeDrafts: boolean }): Promise<{ items: RowDataPacket[]; total: number }> {
    const clause = opts.includeDrafts ? '' : 'WHERE status = 1';
    const items = await query(
        `SELECT id, title, content, author_id, status, is_pinned, published_at, created_at, updated_at
         FROM web_notices ${clause}
         ORDER BY is_pinned DESC, COALESCE(published_at, created_at) DESC
         LIMIT ? OFFSET ?`,
        [opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM web_notices ${clause}`);
    return { items, total: Number(totalRow?.n ?? 0) };
}

export async function getNotice(id: number, includeDrafts = false): Promise<RowDataPacket | undefined> {
    const clause = includeDrafts ? '' : 'AND status = 1';
    return queryOne(
        `SELECT id, title, content, author_id, status, is_pinned, published_at, created_at, updated_at
         FROM web_notices WHERE id = ? ${clause}`,
        [id]
    );
}

export async function createNotice(input: { title: string; content: string; authorId: number; publish: boolean; pinned: boolean }): Promise<number> {
    const result = await execute(
        `INSERT INTO web_notices (title, content, author_id, status, is_pinned, published_at)
         VALUES (?, ?, ?, ?, ?, ${input.publish ? 'CURRENT_TIMESTAMP(3)' : 'NULL'})`,
        [input.title, input.content, input.authorId, input.publish ? 1 : 0, input.pinned ? 1 : 0]
    );
    return result.insertId;
}

export async function updateNotice(
    id: number,
    fields: { title?: string; content?: string; publish?: boolean; pinned?: boolean }
): Promise<void> {
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
    if (fields.pinned !== undefined) {
        sets.push('is_pinned = ?');
        args.push(fields.pinned ? 1 : 0);
    }
    if (fields.publish !== undefined) {
        // 发布时补上发布时间; 转回草稿则清空, 免得草稿混进按发布时间排序的列表
        sets.push('status = ?', 'published_at = ?');
        args.push(fields.publish ? 1 : 0, fields.publish ? new Date() : null);
    }
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_notices SET ${sets.join(', ')} WHERE id = ?`, args);
}

export async function deleteNotice(id: number): Promise<boolean> {
    const result = await execute('DELETE FROM web_notices WHERE id = ?', [id]);
    return result.affectedRows > 0;
}
