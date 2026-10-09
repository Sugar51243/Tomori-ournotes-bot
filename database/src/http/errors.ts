/**
 * 业务错误。op 处理函数只管 throw, 由 errorHandler 统一转成响应。
 *
 * 错误码与 web/server 的 http/errors.ts 保持同一套: 消费方(web)客户端把 code
 * 原样重抛成自己的 AppError, 两边的错误语义才能无缝对接。
 */
export type ErrorCode =
    | 'VALIDATION'
    | 'UNAUTHENTICATED'
    | 'TOKEN_REVOKED'
    | 'BANNED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'DB_UNAVAILABLE'
    | 'UPSTREAM_TIMEOUT'
    | 'UPSTREAM_UNAVAILABLE'
    | 'UPSTREAM_BAD_RESPONSE'
    | 'DOMAIN_ERROR'
    | 'INTERNAL';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
    VALIDATION: 400,
    UNAUTHENTICATED: 401,
    TOKEN_REVOKED: 401,
    BANNED: 403,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    DB_UNAVAILABLE: 503,
    UPSTREAM_TIMEOUT: 504,
    UPSTREAM_UNAVAILABLE: 503,
    UPSTREAM_BAD_RESPONSE: 502,
    DOMAIN_ERROR: 400,
    INTERNAL: 500,
};

export class AppError extends Error {
    readonly code: ErrorCode;
    readonly httpStatus: number;
    /** 校验类错误的字段级原因 */
    readonly fields?: string[];

    constructor(code: ErrorCode, message: string, opts: { httpStatus?: number; fields?: string[] } = {}) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.httpStatus = opts.httpStatus ?? DEFAULT_STATUS[code];
        this.fields = opts.fields;
    }

    static validation(message: string, fields?: string[]): AppError {
        return new AppError('VALIDATION', message, { fields });
    }

    static notFound(message = '内容不存在'): AppError {
        return new AppError('NOT_FOUND', message);
    }

    static forbidden(message = '没有权限执行此操作'): AppError {
        return new AppError('FORBIDDEN', message);
    }

    static conflict(message: string): AppError {
        return new AppError('CONFLICT', message);
    }
}
