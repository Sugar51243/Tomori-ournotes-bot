import { Router, type Request } from 'express';
import { h } from '../http/errorHandler';
import { AppError } from '../http/errors';
import { ok } from '../utils/response';

/**
 * op 派发基建: 每个模块一张 `op 名 -> 处理函数` 的表, 挂成
 *   POST /v1/<module>/<op>
 * 参数就是 JSON body 本身; 返回值放进统一信封 { ok:true, data }。
 *
 * 不做「任意 SQL/任意集合」的通用入口 —— 每个 op 都是明确的语义操作,
 * 公网暴露时这是安全边界本身。
 */
export type OpHandler = (params: Record<string, unknown>, req: Request) => Promise<unknown> | unknown;
export type OpTable = Record<string, OpHandler>;

export function opRouter(table: OpTable): Router {
    const router = Router();
    router.post('/:op', h(async (req, res) => {
        const op = req.params.op;
        const handler = Object.prototype.hasOwnProperty.call(table, op) ? table[op] : undefined;
        if (!handler) throw new AppError('NOT_FOUND', `未知的操作: ${op}`);
        const raw: unknown = req.body ?? {};
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw AppError.validation('请求体必须是 JSON 对象');
        }
        const data = await handler(raw as Record<string, unknown>, req);
        ok(res, data === undefined ? null : data);
    }));
    return router;
}
