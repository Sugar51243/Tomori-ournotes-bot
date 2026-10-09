import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';
import type { Server } from '../../constants';

/**
 * 账号包导入记录的读写(SQL 原样搬自 web/server/src/db/repos/gameAccountRepo.ts)。
 * 与 charts 同一套脾气:
 *  - 删除是软删(deleted_at), 所有查询都带 `deleted_at IS NULL`;
 *  - **列表不拉明细**(cards_data/items_data/songs_data 加起来可能几百 KB),
 *    列表只读 stats; 明细只在 getRow 里取。
 */

/** 明细字段名 ↔ 类别 */
const DETAIL_COLUMN = {
    cards: 'cards_data',
    items: 'items_data',
    songs: 'songs_data',
} as const;

export type AccountCategory = keyof typeof DETAIL_COLUMN;

/** 列表用的列(不含明细大字段) */
const SUMMARY_COLUMNS = `id, user_id, game_uid, server, package_id, player_name, label, player_id,
    show_cards, show_items, show_songs, tgw_card_rank, master_version, schema_ver, stats, created_at, updated_at, deleted_at`;

export async function listByUser(userId: number): Promise<RowDataPacket[]> {
    return query(
        `SELECT ${SUMMARY_COLUMNS} FROM web_game_accounts
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC, id DESC`,
        [userId]
    );
}

export async function getRow(id: number): Promise<RowDataPacket | undefined> {
    return queryOne('SELECT * FROM web_game_accounts WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 只取某一个类别的明细列(公开下发时服务端按可见性挑列, 避免把隐藏的类别一起读出来) */
export async function getDetailCategory(id: number, category: AccountCategory): Promise<unknown> {
    const column = DETAIL_COLUMN[category];
    const row = await queryOne<Record<string, unknown>>(
        `SELECT ${column} AS data FROM web_game_accounts WHERE id = ? AND deleted_at IS NULL`,
        [id]
    );
    return row === undefined ? { found: false } : { found: true, data: row.data ?? null };
}

/**
 * 按玩家公开 ID(+服)找账号包(bot 侧用)。
 * 同一玩家 ID 理论上可能被多个用户各导了一份, 取**最近更新**的一条。
 */
export async function findByPlayerId(playerId: string, server: Server): Promise<RowDataPacket | undefined> {
    return queryOne(
        `SELECT ${SUMMARY_COLUMNS} FROM web_game_accounts
         WHERE player_id = ? AND server = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
        [playerId, server]
    );
}

export async function countByUser(userId: number): Promise<number> {
    const rows = await query<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM web_game_accounts WHERE user_id = ? AND deleted_at IS NULL',
        [userId]
    );
    return Number(rows[0]?.n ?? 0);
}

export interface UpsertInput {
    userId: number;
    gameUid: string | null;
    server: Server;
    packageId: string;
    playerName: string;
    masterVersion: string | null;
    stats: unknown;
    cards: unknown;
    items: unknown;
    songs: unknown;
}

/** 写入一条导入记录(同一 user+game_uid+server 覆盖; 同时复活被软删的行)。 */
export async function upsert(input: UpsertInput): Promise<{ id: number; created: boolean }> {
    const args = [
        input.userId,
        input.gameUid,
        input.server,
        input.packageId,
        input.playerName,
        input.masterVersion,
        JSON.stringify(input.stats),
        JSON.stringify(input.cards),
        JSON.stringify(input.items),
        JSON.stringify(input.songs),
    ];

    // game_uid 为 NULL 时唯一键不生效(MySQL 里 NULL != NULL), 所以「无 UID 的包」
    // 每次导入都会新增一行 —— 这是有意的: 它们之间没有可判定的同一性。
    //
    // `id = LAST_INSERT_ID(id)` 是 MySQL 的固定写法: 命中重复键时把 insertId 掰成
    // 已存在那一行的 id, 于是插入和更新都能从同一个地方拿到 id。
    const res = await execute(
        `INSERT INTO web_game_accounts
             (user_id, game_uid, server, package_id, player_name, master_version,
              stats, cards_data, items_data, songs_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             id             = LAST_INSERT_ID(id),
             package_id     = VALUES(package_id),
             player_name    = VALUES(player_name),
             master_version = VALUES(master_version),
             stats          = VALUES(stats),
             cards_data     = VALUES(cards_data),
             items_data     = VALUES(items_data),
             songs_data     = VALUES(songs_data),
             deleted_at     = NULL`,
        args
    );

    // ON DUPLICATE KEY UPDATE 下 affectedRows: 1 = 新插入, 2 = 覆盖了已有行
    return { id: Number(res.insertId), created: res.affectedRows === 1 };
}

/** 改可见性开关 / 备注名 / 服务器 */
export async function updateVisibility(
    id: number,
    fields: { showCards?: boolean; showItems?: boolean; showSongs?: boolean; label?: string; server?: Server; tgwCardRank?: number; playerId?: string | null }
): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.showCards !== undefined) {
        sets.push('show_cards = ?');
        args.push(fields.showCards ? 1 : 0);
    }
    if (fields.showItems !== undefined) {
        sets.push('show_items = ?');
        args.push(fields.showItems ? 1 : 0);
    }
    if (fields.showSongs !== undefined) {
        sets.push('show_songs = ?');
        args.push(fields.showSongs ? 1 : 0);
    }
    if (fields.label !== undefined) {
        sets.push('label = ?');
        args.push(fields.label);
    }
    if (fields.server !== undefined) {
        sets.push('server = ?');
        args.push(fields.server);
    }
    if (fields.tgwCardRank !== undefined) {
        sets.push('tgw_card_rank = ?');
        args.push(fields.tgwCardRank);
    }
    if (fields.playerId !== undefined) {
        sets.push('player_id = ?');
        args.push(fields.playerId);
    }
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_game_accounts SET ${sets.join(', ')} WHERE id = ?`, args);
}

export async function softDelete(id: number): Promise<boolean> {
    const res = await execute('UPDATE web_game_accounts SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL', [id]);
    return res.affectedRows > 0;
}
