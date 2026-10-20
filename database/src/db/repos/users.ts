import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';
import type { Role } from '../../constants';

/**
 * web_users 的全部读写(SQL 原样搬自 web/server/src/db/repos/userRepo.ts)。
 * 会话微缓存在 web 侧, 这里只做数据面。
 */

export type UserRow = RowDataPacket;

export async function findById(id: number): Promise<UserRow | undefined> {
    return queryOne<UserRow>('SELECT * FROM web_users WHERE id = ?', [id]);
}

/** 登录用: 拿最新的 password_hash 与 status */
export async function findByUsername(username: string): Promise<UserRow | undefined> {
    return queryOne<UserRow>('SELECT * FROM web_users WHERE username = ?', [username]);
}

/**
 * 按昵称/用户名搜索账号(社区快速搜索用)。
 * 只返回未封禁的 —— 被封的账号不该还能被人搜到。
 * `like` 已由调用方过 escapeLike 并带 % 通配。
 */
export async function searchUsers(opts: { like: string; limit: number }): Promise<UserRow[]> {
    return query<UserRow[]>(
        `SELECT * FROM web_users
         WHERE status = 'active' AND (nickname LIKE ? OR username LIKE ?)
         ORDER BY id
         LIMIT ?`,
        [opts.like, opts.like, opts.limit]
    );
}

/** 批量取(社区列表里要把 `web:<id>` 的记录还原成站点账号信息) */
export async function findManyByIds(ids: number[]): Promise<UserRow[]> {
    if (!ids.length) return [];
    return query<UserRow[]>(
        `SELECT * FROM web_users WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
    );
}

export async function usernameExists(username: string): Promise<boolean> {
    const row = await queryOne<{ id: number }>('SELECT id FROM web_users WHERE username = ?', [username]);
    return !!row;
}

export async function createUser(input: {
    username: string;
    nickname: string;
    passwordHash: string;
    role?: Role;
    avatarUrl?: string;
}): Promise<number> {
    const result = await execute(
        `INSERT INTO web_users (username, nickname, password_hash, role, avatar_url)
         VALUES (?, ?, ?, ?, ?)`,
        [input.username, input.nickname, input.passwordHash, input.role ?? 'user', input.avatarUrl ?? null]
    );
    return result.insertId;
}

export async function touchLastLogin(id: number): Promise<void> {
    await execute('UPDATE web_users SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]);
}

export async function updateProfileFields(
    id: number,
    fields: { nickname?: string; avatarUrl?: string | null; profile?: Record<string, unknown> }
): Promise<void> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.nickname !== undefined) {
        sets.push('nickname = ?');
        args.push(fields.nickname);
    }
    if (fields.avatarUrl !== undefined) {
        sets.push('avatar_url = ?');
        args.push(fields.avatarUrl);
    }
    if (fields.profile !== undefined) {
        sets.push('profile = ?');
        args.push(JSON.stringify(fields.profile));
    }
    if (!sets.length) return;
    args.push(id);
    await execute(`UPDATE web_users SET ${sets.join(', ')} WHERE id = ?`, args);
}

/** 改密码一律顺带 bump token_version: 所有旧登录态立即失效 */
export async function updatePassword(id: number, passwordHash: string): Promise<void> {
    await execute(
        'UPDATE web_users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
        [passwordHash, id]
    );
}

export async function bumpTokenVersion(id: number): Promise<void> {
    await execute('UPDATE web_users SET token_version = token_version + 1 WHERE id = ?', [id]);
}

export async function setRole(id: number, role: Role): Promise<void> {
    await execute('UPDATE web_users SET role = ? WHERE id = ?', [role, id]);
}

/** 封禁/解封; 封禁即时踢下线(token_version +1), 解封保留原 token_version */
export async function setStatus(id: number, status: 'active' | 'banned', reason?: string | null): Promise<void> {
    if (status === 'banned') {
        await execute(
            'UPDATE web_users SET status = ?, ban_reason = ?, token_version = token_version + 1 WHERE id = ?',
            [status, reason ?? null, id]
        );
    } else {
        await execute('UPDATE web_users SET status = ?, ban_reason = NULL WHERE id = ?', [status, id]);
    }
}

export async function countByRole(role: Role): Promise<number> {
    const row = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM web_users WHERE role = ?', [role]);
    return Number(row?.n ?? 0);
}

/** 管理后台的用户列表; q 同时匹配用户名与昵称 */
export async function listUsers(opts: { q?: string; offset: number; limit: number }): Promise<{ rows: UserRow[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.q) {
        where.push('(username LIKE ? OR nickname LIKE ?)');
        const like = `%${opts.q}%`;
        args.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await query<UserRow[]>(
        `SELECT * FROM web_users ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...args, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM web_users ${clause}`, args);
    return { rows, total: Number(totalRow?.n ?? 0) };
}
