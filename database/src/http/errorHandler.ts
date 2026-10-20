import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors';
import { fail } from '../utils/response';
import { logger, describeError } from '../logger';

/**
 * 异步路由包装。Express 4 不会自动捕获 async handler 的 rejection ——
 * 不包这一层, 一个没写 try/catch 的 await 就会变成挂起的请求(而不是 500)。
 */
export function h(fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<unknown>): RequestHandler {
    return (req, res, next) => {
        void fn(req, res, next).catch(next);
    };
}

/** 数据库连接类错误: 后端挂了不等于请求写错了, 要报 503 而不是 500 */
function isDbDownError(e: unknown): boolean {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') {
        if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'].includes(code)) {
            return true;
        }
        if (code.startsWith('ER_') || code === 'MongoNetworkError' || code === 'MongoServerSelectionError') return true;
    }
    const name = (e as { name?: unknown }).name;
    return name === 'MongoNetworkError' || name === 'MongoServerSelectionError' || name === 'MongoTimeoutError';
}

/** 统一错误出口: 只在这里决定给客户端看什么, op 里抛出的原始错误不会漏到响应体 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const where = `${req.method} ${req.originalUrl}${req.dbClient ? ` [${req.dbClient}]` : ''}`;

    if (err instanceof AppError) {
        if (err.httpStatus >= 500) logger('op', `${where} → ${err.code}: ${err.message}`, 'warn');
        return fail(res, err.code, err.message, err.httpStatus, err.fields);
    }

    // 请求体不是合法 JSON(express.json 抛的)
    if (err instanceof SyntaxError && 'body' in err) {
        return fail(res, 'VALIDATION', '请求体不是合法的 JSON', 400);
    }

    // 请求体超过 body-parser 的 limit
    if ((err as { type?: string }).type === 'entity.too.large') {
        return fail(res, 'VALIDATION', '提交的内容太大了', 413);
    }

    if (isDbDownError(err)) {
        logger('op', `${where} 数据库不可用: ${describeError(err)}`, 'error');
        return fail(res, 'DB_UNAVAILABLE', '数据库暂时不可用，请稍后再试', 503);
    }

    logger('op', `${where} 未捕获的错误: ${(err as Error)?.stack ?? describeError(err)}`, 'error');
    fail(res, 'INTERNAL', '服务器内部错误', 500);
};
