import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';

/**
 * 沙盒聊天室的存储(SQL 原样搬自 web/server/src/db/repos/chatRepo.ts)。
 * 现在每个账号只有一个 private 房间(slug = `u:<账号ID>`), 但表结构已经按
 * "多房间 + 多人"设计好了 —— 后续开多人房只要插入 kind='public' 的行。
 */

/** 取房间; 不存在就建一个(首次进聊天室时发生) */
export async function ensurePrivateRoom(userId: number, title: string): Promise<RowDataPacket> {
    const slug = `u:${userId}`;
    const existing = await queryOne<RowDataPacket>('SELECT * FROM web_chat_rooms WHERE slug = ?', [slug]);
    if (existing) return existing;

    try {
        const result = await execute(
            "INSERT INTO web_chat_rooms (kind, slug, title, owner_id) VALUES ('private', ?, ?, ?)",
            [slug, title, userId]
        );
        const row = await queryOne<RowDataPacket>('SELECT * FROM web_chat_rooms WHERE id = ?', [result.insertId]);
        if (!row) throw new Error('创建房间后读取失败');
        return row;
    } catch (e) {
        // 并发首次进入: 两个请求同时插入, 唯一索引只会放行一个
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
            const row = await queryOne<RowDataPacket>('SELECT * FROM web_chat_rooms WHERE slug = ?', [slug]);
            if (row) return row;
        }
        throw e;
    }
}

export async function getRoom(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_chat_rooms WHERE id = ?', [id]);
}

/** 历史消息: 倒序取最近 limit 条(翻回正序由 web 侧做) */
export async function listMessages(roomId: number, opts: { limit: number; beforeId?: number }): Promise<RowDataPacket[]> {
    const where = ['room_id = ?'];
    const args: unknown[] = [roomId];
    if (opts.beforeId !== undefined) {
        where.push('id < ?');
        args.push(opts.beforeId);
    }
    args.push(opts.limit);
    return query(
        `SELECT * FROM web_chat_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        args
    );
}

export async function insertMessage(input: {
    roomId: number;
    authorId: number | null;
    kind: 'text' | 'result' | 'error';
    content: string;
    attachment?: string;
}): Promise<RowDataPacket> {
    const result = await execute(
        'INSERT INTO web_chat_messages (room_id, author_id, kind, content, attachment) VALUES (?, ?, ?, ?, ?)',
        [input.roomId, input.authorId, input.kind, input.content, input.attachment ?? null]
    );
    const row = await queryOne<RowDataPacket>('SELECT * FROM web_chat_messages WHERE id = ?', [result.insertId]);
    if (!row) throw new Error('写入消息后读取失败');
    return row;
}

export async function clearMessages(roomId: number): Promise<number> {
    const result = await execute('DELETE FROM web_chat_messages WHERE room_id = ?', [roomId]);
    return result.affectedRows;
}

/** 清理孤儿附件记录(附件文件本身由定时任务按修改时间删) */
export async function findOldAttachments(olderThan: Date): Promise<string[]> {
    const rows = await query<Array<{ attachment: string }>>(
        'SELECT DISTINCT attachment FROM web_chat_messages WHERE attachment IS NOT NULL AND created_at < ?',
        [olderThan]
    );
    return rows.map(r => r.attachment);
}
