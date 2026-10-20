import { config } from '../config';

/**
 * 数据库 API 客户端。全部 MySQL/MongoDB 行为都在「数据库 API」那个独立进程里,
 * 本进程只发 POST /v1/<module>/<op> 的语义化请求(见 database/README.md)。
 *
 * 约定:
 * - 不自动重试。写操作重试会把「已成功但响应丢了」变成重复提交; 读的失败恢复
 *   由各调用方自己的机制处理(榜线运行时本来就有退避探测, 关键词快照按 TTL 重读)。
 * - 错误分两层: 「连接层」(未配置/网络错/超时/对端 DB_UNAVAILABLE) 与
 *   「操作层」(业务错误码, 如 CONFLICT/VALIDATION)。callDbApiSoft 把前者折叠成
 *   undefined(对应社区功能一直以来的 db_disabled 语义), 后者照旧抛出。
 */

export function dbApiConfigured(): boolean {
    return !!config.dbApiBaseUrl;
}

export class DbApiError extends Error {
    /** 对端业务错误码(见 database/ 项目的 ErrorCode); 连接层失败为 undefined */
    readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'DbApiError';
        this.code = code;
    }

    /** 连接层失败(未配置/网络/超时/对端库不可用) —— 上层据此走降级或 db_disabled */
    get unavailable(): boolean {
        return this.code === undefined || this.code === 'DB_UNAVAILABLE' || this.code === 'UPSTREAM_UNAVAILABLE';
    }
}

interface Envelope<T> {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string };
}

async function request<T>(module: string, op: string, params: Record<string, unknown>): Promise<T> {
    const url = `${config.dbApiBaseUrl}/v1/${encodeURIComponent(module)}/${encodeURIComponent(op)}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.dbApiToken}`
            },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(config.dbApiTimeoutMs)
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new DbApiError(`数据库 API 请求失败(${module}.${op}): ${msg}`);
    }

    let body: Envelope<T> | undefined;
    try {
        body = (await res.json()) as Envelope<T>;
    } catch {
        body = undefined;
    }

    if (res.ok && body?.ok === true) return body.data as T;
    const code = body?.error?.code;
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    throw new DbApiError(`数据库 API 错误(${module}.${op}): ${message}`, code);
}

/** 调一个 op; 任何失败都抛 DbApiError */
export async function callDbApi<T>(module: string, op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!dbApiConfigured()) {
        throw new DbApiError(`数据库 API 未配置(DB_API_BASE_URL 为空)`, 'DB_UNAVAILABLE');
    }
    return request<T>(module, op, params);
}

/**
 * 社区功能专用: 「没配/连不上/对端库挂了」折叠成 undefined(= 旧的 db_disabled),
 * 业务错误(重复、校验、冲突)照旧抛出 —— 与旧实现的「连接失败→db_disabled、
 * 写入失败→throw」分层一致。
 */
export async function callDbApiSoft<T>(module: string, op: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    try {
        return await callDbApi<T>(module, op, params);
    } catch (e) {
        // 连接层失败静默折叠(与旧实现 `.catch(() => undefined)` 一致, 避免未启用时刷日志);
        // 调用方路由会按 db_disabled 给用户提示
        if (e instanceof DbApiError && e.unavailable) return undefined;
        throw e;
    }
}
