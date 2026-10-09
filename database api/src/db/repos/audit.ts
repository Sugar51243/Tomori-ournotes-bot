import { RowDataPacket } from 'mysql2/promise';
import { query, queryOne, execute } from '../mysql';
import type { Role } from '../../constants';

/** 管理审计: 每一次管理动作都留一行, 供管理台查阅与事后追责(SQL 原样搬自 web 的 auditRepo)。 */

export interface AuditEntry {
    actorId: number;
    actorRole: Role;
    action: string;
    targetType: string;
    targetId?: number;
    detail?: unknown;
    ip?: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
    await execute(
        `INSERT INTO web_audit_logs (actor_id, actor_role, action, target_type, target_id, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            entry.actorId,
            entry.actorRole,
            entry.action,
            entry.targetType,
            entry.targetId ?? null,
            entry.detail === undefined ? null : JSON.stringify(entry.detail),
            entry.ip ?? null,
        ]
    );
}

export async function listAudit(opts: { offset: number; limit: number; action?: string }): Promise<{ items: RowDataPacket[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.action) {
        where.push('a.action = ?');
        args.push(opts.action);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const items = await query(
        `SELECT a.id, a.actor_id, u.nickname AS actor_nickname, a.actor_role, a.action,
                a.target_type, a.target_id, a.detail, a.ip, a.created_at
         FROM web_audit_logs a
         LEFT JOIN web_users u ON u.id = a.actor_id
         ${clause}
         ORDER BY a.id DESC
         LIMIT ? OFFSET ?`,
        [...args, opts.limit, opts.offset]
    );
    const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM web_audit_logs a ${clause}`, args);
    return { items, total: Number(totalRow?.n ?? 0) };
}
