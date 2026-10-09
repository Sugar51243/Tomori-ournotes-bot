import { query, execute } from '../mysql';
import type { Server } from '../../constants';

/**
 * 曲名缓存(SQL 原样搬自 web 的 songCacheRepo)。
 * 榜线页的图例要显示曲名, 而 bot 唯一能返回曲名的 JSON 端点 /songChartData
 * 顺带要拉整份谱面(不算轻), 所以拉一次就落表。
 */

export async function getCachedTitle(songId: number, server: Server): Promise<string | undefined> {
    const rows = await query<Array<{ title: string }>>(
        'SELECT title FROM web_song_cache WHERE song_id = ? AND server = ?',
        [songId, server]
    );
    return rows[0]?.title;
}

export async function putCachedTitles(server: Server, entries: Array<{ songId: number; title: string }>): Promise<void> {
    if (!entries.length) return;
    // 用 VALUES 批量 upsert; 曲名可能随上游修订变化, 所以是更新而不是忽略
    const placeholders = entries.map(() => '(?, ?, ?)').join(', ');
    const args: unknown[] = [];
    for (const e of entries) args.push(e.songId, server, e.title);
    await execute(
        `INSERT INTO web_song_cache (song_id, server, title, fetched_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE title = VALUES(title), fetched_at = CURRENT_TIMESTAMP(3)`,
        args
    );
}
