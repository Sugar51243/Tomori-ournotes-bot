import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { AppError } from './errors';

/**
 * Bearer 令牌鉴权。公网部署的边界就在这里:
 * - 令牌表在启动时哈希成 sha256, 比对用 timingSafeEqual(长度差异先被哈希抹平)
 * - 遍历完整个表才返回, 不因命中提前退出 —— 比对耗时与"命中第几个"无关
 * - 可选 IP 白名单(DB_API_IP_ALLOWLIST), 在验令牌之前先拦
 *
 * 注意威胁模型: 任何持有令牌的 client 都能触达全部端点。令牌泄露 ≈ 数据库全量
 * 泄露, 所以令牌必须与数据库凭据同级保管(只放在各消费方 .env 与本服务 .env)。
 */

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

const TOKEN_DIGESTS: ReadonlyArray<{ name: string; digest: Buffer }> =
    config.tokens.map(t => ({ name: t.name, digest: digest(t.token) }));

/** 常量时间比对: 返回命中的 client 名 */
export function matchToken(presented: string): string | undefined {
    const d = digest(presented);
    let hit: string | undefined;
    for (const t of TOKEN_DIGESTS) {
        if (timingSafeEqual(d, t.digest)) hit = t.name;
    }
    return hit;
}

function bearerToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = m?.[1]?.trim();
    return token || undefined;
}

/** 取真实来源 IP; ::ffff:1.2.3.4 归一成 1.2.3.4 再与白名单比 */
function remoteIp(req: Request): string {
    const raw = req.ip ?? req.socket.remoteAddress ?? '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** 白名单条目: 精确 IP 或 IPv4 CIDR(如 203.0.113.0/24); IPv6 只支持精确匹配 */
type AllowEntry = { kind: 'exact'; ip: string } | { kind: 'v4cidr'; base: number; mask: number };

function parseAllowEntry(entry: string): AllowEntry | undefined {
    const slash = entry.indexOf('/');
    if (slash < 0) return { kind: 'exact', ip: entry };
    const base = ipv4ToInt(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (base === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { kind: 'v4cidr', base: (base & mask) >>> 0, mask };
}

function ipv4ToInt(ip: string): number | undefined {
    const parts = ip.split('.');
    if (parts.length !== 4) return undefined;
    let n = 0;
    for (const p of parts) {
        const b = Number(p);
        if (!Number.isInteger(b) || b < 0 || b > 255) return undefined;
        n = (n << 8) | b;
    }
    return n >>> 0;
}

const ALLOWLIST: AllowEntry[] = config.ipAllowlist
    .map(raw => {
        const parsed = parseAllowEntry(raw);
        if (!parsed) logger('auth', `IP 白名单条目解析失败, 已忽略: ${raw}`, 'warn');
        return parsed;
    })
    .filter((e): e is AllowEntry => e !== undefined);

if (ALLOWLIST.length) {
    logger('auth', `IP 白名单已启用: ${config.ipAllowlist.join(', ')}`);
}

function ipAllowed(ip: string): boolean {
    // 实际来源可能是 IPv6 表示(::1 之类); 精确匹配对 IPv6/IPv4 都适用
    const v4 = ipv4ToInt(ip);
    return ALLOWLIST.some(e => {
        if (e.kind === 'exact') return e.ip === ip;
        return v4 !== undefined && ((v4 & e.mask) >>> 0) === e.base;
    });
}

export const requireToken: RequestHandler = (req, _res, next) => {
    if (ALLOWLIST.length) {
        const ip = remoteIp(req);
        if (!ipAllowed(ip)) {
            return next(new AppError('FORBIDDEN', '来源 IP 不在白名单内'));
        }
    }
    const token = bearerToken(req);
    if (!token) return next(new AppError('UNAUTHENTICATED', '缺少访问令牌'));
    const name = matchToken(token);
    if (!name) return next(new AppError('UNAUTHENTICATED', '访问令牌无效'));
    req.dbClient = name;
    next();
};
