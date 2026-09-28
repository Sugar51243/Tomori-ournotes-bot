import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { config } from '../config';
import { logger } from '../logger';

/**
 * 磁盘缓存: 布局为 CACHE_DIR 下的相对 key。
 * - 原子写(key.tmp -> rename)
 * - .etag 边车文件保存 ETag, 用于 304 重验证
 * - 单飞合并: 同一 key 的并发读取共享一个 Promise
 * - key 消毒: 拒绝绝对路径/.., 超长 key 哈希化
 */
export class DiskCache {
    private inflight = new Map<string, Promise<unknown>>();

    private resolveKey(key: string): string {
        let k = key.replace(/\\/g, '/').replace(/^\/+/, '');
        if (k.includes('..')) throw new Error(`invalid cache key: ${key}`);
        if (/^[a-zA-Z]:/.test(k)) throw new Error(`invalid cache key: ${key}`);
        if (k.length > 120) {
            const hash = createHash('sha256').update(k).digest('hex').slice(0, 16);
            const ext = path.extname(k);
            k = `hashed/${hash}${ext}`;
        }
        return path.join(config.cacheDir, k);
    }

    async read(key: string): Promise<{ data: Buffer; mtimeMs: number; etag?: string } | undefined> {
        const file = this.resolveKey(key);
        try {
            const stat = await fs.stat(file);
            const [data, etag] = await Promise.all([
                fs.readFile(file),
                fs.readFile(`${file}.etag`, 'utf8').catch(() => undefined)
            ]);
            return { data, mtimeMs: stat.mtimeMs, etag: etag?.trim() || undefined };
        } catch {
            return undefined;
        }
    }

    async write(key: string, data: Buffer, opts?: { etag?: string }): Promise<void> {
        const file = this.resolveKey(key);
        const dir = path.dirname(file);
        await fs.mkdir(dir, { recursive: true });
        const tmp = `${file}.${Date.now().toString(36)}.tmp`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, file);
        if (opts?.etag) await fs.writeFile(`${file}.etag`, opts.etag, 'utf8');
    }

    /** 更新 mtime(ETag 304 命中时刷新 TTL 用) */
    async touch(key: string): Promise<void> {
        const file = this.resolveKey(key);
        try {
            const now = new Date();
            await fs.utimes(file, now, now);
        } catch {
            /* 文件不存在则忽略 */
        }
    }

    isFresh(cached: { mtimeMs: number } | undefined, ttlS: number): boolean {
        return !!cached && Date.now() - cached.mtimeMs < ttlS * 1000;
    }

    /**
     * 单飞: 同一 key 并发时只执行一次 fetcher, 其余共享结果。
     * fetcher 返回 undefined 表示"无法获取"(网络失败且无缓存)。
     */
    async singleFlight<T>(key: string, fetcher: () => Promise<T | undefined>): Promise<T | undefined> {
        const existing = this.inflight.get(key);
        if (existing) return (await existing) as T | undefined;
        const p = fetcher().finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, p);
        return await p;
    }

    /** 启动清理: 删除不属于当前/上一个 dataVersion 的 masterdata 表目录 */
    async pruneMasterdataVersions(keepVersions: string[]): Promise<void> {
        const dir = path.join(config.cacheDir, 'masterdata', 'tables');
        const keep = new Set(keepVersions.filter(Boolean));
        try {
            const entries = await fs.readdir(dir);
            for (const e of entries) {
                if (!keep.has(e)) {
                    await fs.rm(path.join(dir, e), { recursive: true, force: true });
                    logger('cache', `pruned masterdata version ${e}`);
                }
            }
        } catch {
            /* 目录不存在 */
        }
    }
}

export const diskCache = new DiskCache();
