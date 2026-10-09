import express from 'express';

/**
 * 未启用数据库/社区基建时的占位路由(与 tsugu 无 DB 时行为一致):
 * 所有 POST 返回 404 {'status':'fail','data':'错误: 服务器未启用数据库'}
 */
export function disabledRouter(): express.Router {
    const router = express.Router();
    router.post('*', (_req: express.Request, res: express.Response) => {
        res.status(404).send({
            status: 'fail',
            data: '错误: 服务器未启用数据库'
        });
    });
    return router;
}
