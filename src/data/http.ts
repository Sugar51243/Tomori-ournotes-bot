import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { logger } from '../logger';

/**
 * 带礼貌限流的 HTTP 客户端:
 * - 每主机并发上限 MAX_CONCURRENCY_PER_HOST
 * - 同主机请求最小间隔 100ms
 * - 网络错误/5xx 重试 3 次(1s/3s/9s 退避), 4xx 不重试
 */
class Http {
    private semaphores = new Map<string, { count: number; queue: Array<() => void> }>();
    private lastRequestAt = new Map<string, number>();
    private client = axios.create({ timeout: config.httpTimeoutMs, headers: { 'User-Agent': config.userAgent } });

    private async acquire(host: string): Promise<void> {
        const sem = this.semaphores.get(host) ?? { count: 0, queue: [] };
        this.semaphores.set(host, sem);
        if (sem.count < config.maxConcurrencyPerHost) {
            sem.count++;
            return;
        }
        await new Promise<void>(resolve => sem.queue.push(resolve));
        sem.count++;
    }

    private release(host: string): void {
        const sem = this.semaphores.get(host);
        if (!sem) return;
        sem.count--;
        const next = sem.queue.shift();
        if (next) next();
    }

    private async pace(host: string): Promise<void> {
        const last = this.lastRequestAt.get(host) ?? 0;
        const wait = last + 100 - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastRequestAt.set(host, Date.now());
    }

    async request<T>(url: string, options: AxiosRequestConfig, retries = 3): Promise<T> {
        const host = new URL(url).hostname;
        await this.acquire(host);
        try {
            let attempt = 0;
            for (;;) {
                try {
                    await this.pace(host);
                    const res = await this.client.request({ url, ...options });
                    return res.data as T;
                } catch (e) {
                    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
                    const retryable = status === undefined || status >= 500;
                    if (!retryable || attempt >= retries) throw e;
                    attempt++;
                    const delay = 1000 * 3 ** (attempt - 1);
                    logger('http', `retry(${attempt}/${retries}) ${url} after ${delay}ms: ${axios.isAxiosError(e) ? e.message : e}`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } finally {
            this.release(host);
        }
    }

    /** 返回 {status, headers, data} 以便做 ETag 重验证 */
    async requestFull(url: string, options: AxiosRequestConfig = {}, retries = 3): Promise<{ status: number; headers: Record<string, string>; data: Buffer }> {
        const host = new URL(url).hostname;
        await this.acquire(host);
        try {
            let attempt = 0;
            for (;;) {
                try {
                    await this.pace(host);
                    const res = await this.client.request({
                        url,
                        responseType: 'arraybuffer',
                        validateStatus: s => (s >= 200 && s < 300) || s === 304,
                        ...options
                    });
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
                    return { status: res.status, headers, data: Buffer.from(res.data ?? []) };
                } catch (e) {
                    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
                    const retryable = status === undefined || status >= 500;
                    if (!retryable || attempt >= retries) throw e;
                    attempt++;
                    const delay = 1000 * 3 ** (attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } finally {
            this.release(host);
        }
    }

    async getJSON<T>(url: string): Promise<T> {
        return this.request<T>(url, { method: 'GET', responseType: 'json' });
    }

    async getBuffer(url: string): Promise<Buffer> {
        return this.request<Buffer>(url, { method: 'GET', responseType: 'arraybuffer' }).then(d => Buffer.from(d as unknown as ArrayBuffer));
    }
}

export const http = new Http();

export class HttpStatusError extends Error {
    constructor(public status: number, url: string) {
        super(`HTTP ${status} ${url}`);
    }
}
