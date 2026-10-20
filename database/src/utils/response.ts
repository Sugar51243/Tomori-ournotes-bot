import type { Response } from 'express';
import type { ErrorCode } from '../http/errors';
import { encodeDates } from './dates';

/**
 * 统一响应形状(与 web/server 的 utils/response.ts 相同):
 *   成功 { ok: true,  data }
 *   失败 { ok: false, error: { code, message, fields? } }
 *
 * 成功路径统一走一遍 encodeDates —— Date 编码成 {$date: ISO}, 消费方客户端解码回
 * Date, 保证 MySQL DATETIME / Mongo Date 经由 HTTP 往返后类型不丢(见 utils/dates.ts)。
 */
export function ok<T>(res: Response, data: T, status = 200): void {
    res.status(status).send({ ok: true, data: encodeDates(data) });
}

export function fail(res: Response, code: ErrorCode, message: string, status: number, fields?: string[]): void {
    res.status(status).send({ ok: false, error: fields ? { code, message, fields } : { code, message } });
}
