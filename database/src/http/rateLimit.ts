import type { Request, RequestHandler, Response } from 'express';
import { AppError } from './errors';

/**
 * 进程内滑动窗口限流(与 web/server 的同名模块同款, 键改成 client 名)。
 * 单进程部署够用; 将来多实例要换成 Redis 之类的共享计数。
 */

interface Bucket {
    /** 命中时刻(ms), 按时间升序 */
    hits: number[];
}

const buckets = new Map<string, Bucket>();

/** 定期清掉空桶, 否则被扫过的键会永久占内存 */
const CLEANUP_MS = 10 * 60 * 1000;
const cleanupTimer = setInterval(() => {
    const deadline = Date.now() - CLEANUP_MS;
    for (const [key, bucket] of buckets) {
        if (!bucket.hits.length || bucket.hits[bucket.hits.length - 1] < deadline) buckets.delete(key);
    }
}, CLEANUP_MS);
cleanupTimer.unref?.();

export interface RateLimitOptions {
    windowMs: number;
    max: number;
    scope: string;
    message?: string;
    /** 默认按 client 名(鉴权后)分桶; 未鉴权端点传 'ip' */
    keyBy?: 'client' | 'ip';
}

function bucketKey(req: Request, opts: RateLimitOptions): string {
    if (opts.keyBy === 'ip') {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        return `${opts.scope}:ip:${ip}`;
    }
    return `${opts.scope}:client:${req.dbClient ?? 'unknown'}`;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
    return (req: Request, res: Response, next) => {
        const key = bucketKey(req, opts);
        const now = Date.now();
        const bucket = buckets.get(key) ?? { hits: [] };
        // 丢掉窗口外的命中
        const cutoff = now - opts.windowMs;
        while (bucket.hits.length && bucket.hits[0] < cutoff) bucket.hits.shift();

        if (bucket.hits.length >= opts.max) {
            const retryS = Math.ceil((bucket.hits[0] + opts.windowMs - now) / 1000);
            res.setHeader('Retry-After', String(Math.max(retryS, 1)));
            return next(new AppError('RATE_LIMITED', opts.message ?? `请求过于频繁，请 ${Math.max(retryS, 1)} 秒后再试`));
        }

        bucket.hits.push(now);
        buckets.set(key, bucket);
        next();
    };
}

/** 供 /api/health 观测用 */
export function rateLimitBucketCount(): number {
    return buckets.size;
}
