import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute, withTransaction } from '../mysql';
import { AppError } from '../../http/errors';
import type { ChartSort } from '../../constants';

/**
 * 自制谱读写(SQL 原样搬自 web/server/src/db/repos/chartRepo.ts)。与 forum 同一套脾气:
 *  - 作者信息一律 JOIN web_users 现取;
 *  - 删除是软删(deleted_at), 所有查询都带 `deleted_at IS NULL`;
 *  - 列表不拉 chart_data(一份谱几百 KB, 一页 20 条就是十几 MB)。
 *
 * 行 -> ChartListItem 的字段翻译留在 web 侧。
 */

/** 排序只能来自这份白名单 —— 它会被拼进 SQL */
const SORT_SQL: Record<ChartSort, string> = {
    /** Sonolus 列表用这条：**按 ID 逆序**（新谱在前），与官方谱面的排序口径一致 */
    id: 'c.id DESC',
    latest: 'c.updated_at DESC, c.id DESC',
    notes: 'c.note_count DESC, c.updated_at DESC',
};

const LIST_COLUMNS = `c.id, c.music_id AS musicId, c.difficulty, c.title, c.song_title AS songTitle,
    c.song_artist AS songArtist, c.origin, c.cover_file AS coverFile,
    LEFT(COALESCE(c.description, ''), 240) AS description,
    c.note_count AS noteCount, c.audio_kind AS audioKind, c.status, c.post_id AS postId,
    c.author_id AS authorId, u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole,
    c.created_at AS createdAt, c.updated_at AS updatedAt`;

const LIST_FROM = `FROM web_charts c JOIN web_users u ON u.id = c.author_id`;

/** 公开列表: 只有已发布且未删除的 */
export async function listPublished(opts: {
    like?: string;
    difficulty?: string;
    musicId?: number;
    sort: ChartSort;
    offset: number;
    limit: number;
}): Promise<{ items: RowDataPacket[]; total: number }> {
    const where: string[] = ["c.status = 'published'", 'c.deleted_at IS NULL'];
    const args: unknown[] = [];
    if (opts.like) {
        where.push('(c.title LIKE ? OR c.song_title LIKE ? OR c.song_artist LIKE ?)');
        args.push(opts.like, opts.like, opts.like);
    }
    if (opts.difficulty) {
        where.push('c.difficulty = ?');
        args.push(opts.difficulty);
    }
    if (opts.musicId) {
        where.push('c.music_id = ?');
        args.push(opts.musicId);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = await query(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${whereSql} ORDER BY ${SORT_SQL[opts.sort]} LIMIT ? OFFSET ?`,
        [...args, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${LIST_FROM} ${whereSql}`, args);
    return { items: rows, total: Number(totalRow?.n ?? 0) };
}

/** 我的草稿箱: 作者自己的, 按状态筛 */
export async function listByAuthor(opts: {
    authorId: number;
    status?: 'draft' | 'published';
    offset: number;
    limit: number;
}): Promise<{ items: RowDataPacket[]; total: number }> {
    const where: string[] = ['c.author_id = ?', 'c.deleted_at IS NULL'];
    const args: unknown[] = [opts.authorId];
    if (opts.status) {
        where.push('c.status = ?');
        args.push(opts.status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = await query(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${whereSql} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
        [...args, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${LIST_FROM} ${whereSql}`, args);
    return { items: rows, total: Number(totalRow?.n ?? 0) };
}

/** 原始行(含 chart_data), 权限判断用; 不过滤 status —— 草稿也要能被作者取到 */
export async function getRow(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_charts WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 详情: 行 + 作者信息(合并成一行返回, web 侧再拆) */
export async function getDetail(id: number): Promise<RowDataPacket | undefined> {
    return queryOne(
        `SELECT c.*, u.nickname AS authorNickname, u.avatar_url AS authorAvatar, u.role AS authorRole
         FROM web_charts c JOIN web_users u ON u.id = c.author_id
         WHERE c.id = ? AND c.deleted_at IS NULL`,
        [id]
    );
}

export interface CreateChartInput {
    authorId: number;
    musicId: number;
    difficulty: string;
    title: string;
    songTitle: string;
    songArtist: string;
    description: string | null;
    chartData: string;
    noteCount: number;
    origin: 'official' | 'standalone';
    audioKind: 'upstream' | 'upload';
    audioFile: string | null;
    audioDurationMs: number | null;
    audioSampleRate: number | null;
    coverFile: string | null;
}

export async function create(input: CreateChartInput): Promise<number> {
    const result = await execute(
        `INSERT INTO web_charts
            (author_id, music_id, difficulty, title, song_title, song_artist, description, chart_data, note_count,
             origin, audio_kind, audio_file, audio_duration_ms, audio_sample_rate, cover_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            input.authorId,
            input.musicId,
            input.difficulty,
            input.title,
            input.songTitle,
            input.songArtist,
            input.description,
            input.chartData,
            input.noteCount,
            input.origin,
            input.audioKind,
            input.audioFile,
            input.audioDurationMs,
            input.audioSampleRate,
            input.coverFile,
        ]
    );
    return result.insertId;
}

/** 局部更新。music_id/difficulty 不可改(改了就是另一首谱, 该新建) */
export async function update(
    id: number,
    fields: {
        title?: string;
        songTitle?: string;
        songArtist?: string;
        description?: string | null;
        chartData?: string;
        noteCount?: number;
        audioKind?: 'upstream' | 'upload';
        audioFile?: string | null;
        audioDurationMs?: number | null;
        audioSampleRate?: number | null;
        coverFile?: string | null;
    }
): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        args.push(v);
    };
    if (fields.title !== undefined) put('title', fields.title);
    if (fields.songTitle !== undefined) put('song_title', fields.songTitle);
    if (fields.songArtist !== undefined) put('song_artist', fields.songArtist);
    if (fields.description !== undefined) put('description', fields.description);
    if (fields.chartData !== undefined) put('chart_data', fields.chartData);
    if (fields.noteCount !== undefined) put('note_count', fields.noteCount);
    if (fields.audioKind !== undefined) put('audio_kind', fields.audioKind);
    if (fields.audioFile !== undefined) put('audio_file', fields.audioFile);
    if (fields.audioDurationMs !== undefined) put('audio_duration_ms', fields.audioDurationMs);
    if (fields.audioSampleRate !== undefined) put('audio_sample_rate', fields.audioSampleRate);
    if (fields.coverFile !== undefined) put('cover_file', fields.coverFile);
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_charts SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, args);
}

export async function softDelete(id: number): Promise<boolean> {
    const result = await execute(
        'UPDATE web_charts SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL',
        [id]
    );
    return result.affectedRows > 0;
}

/** 只改状态(下架用); 论坛帖子保留为墓碑, 指向它的旧链接不会 404 */
export async function setStatus(id: number, status: 'draft' | 'published'): Promise<void> {
    await execute('UPDATE web_charts SET status = ? WHERE id = ? AND deleted_at IS NULL', [status, id]);
}

/**
 * 发布: 置为 published 并保证论坛有一篇对应帖子。
 * 全程一个事务 —— 帖子建了但状态没改, 或反过来, 都会留下一半的烂摊子。
 *
 * `post_id` 有值且帖子还活着就复用它(改标题/正文, 绝不重复发帖);
 * 帖子被删/被锁就只跳过内容同步(锁定)或另建一篇(已删除)。
 */
export async function publishWithPost(input: {
    id: number;
    authorId: number;
    boardId: number;
    title: string;
    content: string;
}): Promise<{ postId: number }> {
    return withTransaction(async conn => {
        const [rows] = await conn.query(
            'SELECT post_id, status FROM web_charts WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
            [input.id]
        );
        const row = (rows as Array<{ post_id: number | null; status: string }>)[0];
        if (!row) throw AppError.notFound('自制谱不存在或已被删除');
        if (row.status === 'published') throw AppError.conflict('这份自制谱已经发布过了');

        let postId = row.post_id === null ? null : Number(row.post_id);
        if (postId) {
            const [posts] = await conn.query('SELECT id, status, is_locked FROM web_forum_posts WHERE id = ?', [postId]);
            const post = (posts as Array<{ id: number; status: number; is_locked: number }>)[0];
            if (!post || Number(post.status) !== 1) {
                postId = null; // 帖子没了, 重新建一篇
            } else if (!Number(post.is_locked)) {
                await conn.query(
                    'UPDATE web_forum_posts SET title = ?, content = ?, last_activity_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
                    [input.title, input.content, postId]
                );
            }
        }
        if (!postId) {
            const [ins] = await conn.query(
                `INSERT INTO web_forum_posts (board_id, author_id, title, content, last_activity_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
                [input.boardId, input.authorId, input.title, input.content]
            );
            postId = (ins as { insertId: number }).insertId;
        }
        await conn.query("UPDATE web_charts SET status = 'published', post_id = ? WHERE id = ?", [postId, input.id]);
        return { postId };
    });
}

/** 已发布谱面改了标题/简介时, 同步到对应帖子(帖子不在或被锁就静默跳过) */
export async function syncPostContent(postId: number, fields: { title: string; content: string }): Promise<void> {
    await execute(
        `UPDATE web_forum_posts SET title = ?, content = ?, last_activity_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 1 AND is_locked = 0`,
        [fields.title, fields.content, postId]
    );
}

/** 音频清理用: 仍被未删除的自制谱引用的文件名 */
export async function listReferencedAudioFiles(): Promise<string[]> {
    const rows = await query<Array<{ audio_file: string }>>(
        'SELECT DISTINCT audio_file FROM web_charts WHERE audio_file IS NOT NULL AND deleted_at IS NULL'
    );
    return rows.map(r => r.audio_file);
}

/** 封面清理用: 仍被未删除的自制谱引用的封面文件名 */
export async function listReferencedCoverFiles(): Promise<string[]> {
    const rows = await query<Array<{ cover_file: string }>>(
        'SELECT DISTINCT cover_file FROM web_charts WHERE cover_file IS NOT NULL AND deleted_at IS NULL'
    );
    return rows.map(r => r.cover_file);
}
