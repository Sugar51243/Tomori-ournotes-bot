import { randomInt } from 'node:crypto';
import { execute, query, queryOne } from '../mysql';

/**
 * bot 绑定码的读写(SQL 原样搬自 web 的 bindRepo)。
 *
 * 用途: 用户在网页为自己的某个账号包签发一次性短时码, 发到 QQ 里让 bot 兑换成
 * 「QQ ↔ 该账号」绑定 —— 证明归属用, **不解锁任何隐藏数据**。
 */

/** 码的有效期(发放后)。人在 QQ 里粘贴的工夫, 15 分钟足够。 */
export const BIND_CODE_TTL_MS = 15 * 60 * 1000;
/** 码表: 去掉 0/O/1/I 等易混字符, 口头转述也不容易错 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function randomCode(): string {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return out;
}

/** 给某账号包签发一个绑定码; 顺手清掉过期的旧码(表很小, 不需要定时任务) */
export async function issueCode(userId: number, accountId: number): Promise<{ code: string; expiresAt: number }> {
    await execute('DELETE FROM web_bind_codes WHERE expires_at < NOW(3)').catch(() => undefined);
    // 极端并发下撞码(1/32^8)重试几次即可
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        try {
            await execute(
                'INSERT INTO web_bind_codes (code, user_id, account_id, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))',
                [code, userId, accountId, Math.floor(BIND_CODE_TTL_MS / 1000)]
            );
            return { code, expiresAt: Date.now() + BIND_CODE_TTL_MS };
        } catch (e) {
            const errno = (e as { errno?: number }).errno;
            if (errno !== 1062) throw e;   // 1062 = 主键冲突, 重摇; 其它错误照抛
        }
    }
    throw new Error('绑定码生成失败(连续撞码)');
}

/** 兑换失败的原因(与成功值一起做判别联合, 调用方逐个给不同文案) */
export type ConsumeResult =
    | { kind: 'ok'; userId: number; accountId: number }
    | { kind: 'not_found' }
    | { kind: 'used' }
    | { kind: 'expired' };

/**
 * 兑换绑定码(一次性)。用单条 UPDATE 原子地"标记已用", 并发兑换只有一个能成。
 * 失败时再查一次区分原因(不存在/已用/过期), 好给用户准确的提示。
 */
export async function consumeCode(code: string): Promise<ConsumeResult> {
    const res = await execute(
        'UPDATE web_bind_codes SET used_at = NOW(3) WHERE code = ? AND used_at IS NULL AND expires_at > NOW(3)',
        [code]
    );
    if (res.affectedRows === 1) {
        const row = await queryOne<{ user_id: number | string; account_id: number | string }>(
            'SELECT user_id, account_id FROM web_bind_codes WHERE code = ?',
            [code]
        );
        if (!row) return { kind: 'not_found' };   // 理论上不会发生
        return { kind: 'ok', userId: Number(row.user_id), accountId: Number(row.account_id) };
    }
    const row = await queryOne<{ used_at: string | Date | null; expires_at: string | Date }>(
        'SELECT used_at, expires_at FROM web_bind_codes WHERE code = ?',
        [code]
    );
    if (!row) return { kind: 'not_found' };
    if (row.used_at) return { kind: 'used' };
    return { kind: 'expired' };
}

/** 该账号包是否被某个用户签过码(仅用于测试/诊断, 业务侧不用) */
export async function countByAccount(accountId: number): Promise<number> {
    const rows = await query<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM web_bind_codes WHERE account_id = ?',
        [accountId]
    );
    return Number(rows[0]?.n ?? 0);
}
