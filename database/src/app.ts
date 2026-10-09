import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { requireToken } from './http/auth';
import { rateLimit, rateLimitBucketCount } from './http/rateLimit';
import { errorHandler } from './http/errorHandler';
import { mysqlStatus } from './db/mysql';
import { mongoStatus } from './db/mongo';
import { schemaReady } from './bootstrap';
import { v1Router } from './routes';
import { fail } from './utils/response';

export function createApp(): express.Express {
    const app = express();

    // 反代部署时 req.ip 才反映真实客户端(IP 白名单与限流都依赖它)
    if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
    app.disable('x-powered-by');

    // 自制谱 chart_data 有几百 KB; 上限由 DB_API_BODY_LIMIT_MB 配置
    app.use(express.json({ limit: `${config.bodyLimitMb}mb` }));

    // 极简请求日志: 只记 /v1 与慢请求
    app.use((req, res, next) => {
        const started = Date.now();
        res.on('finish', () => {
            const ms = Date.now() - started;
            if (req.path.startsWith('/v1') || ms > 1000) {
                logger('http', `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, res.statusCode >= 500 ? 'error' : 'debug');
            }
        });
        next();
    });

    // 轻量存活端点(不含数据库探测)
    app.get('/health', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, service: 'tomori-database-api', upTimeS: Math.round(process.uptime()) });
    });

    // 自检端点: 带两库状态与运行摘要; 不鉴权但有限流, 也不泄露连接串等细节
    app.get('/api/health', rateLimit({ scope: 'health', keyBy: 'ip', windowMs: 60_000, max: config.rateLimitIpPerMin }), async (_req, res) => {
        const [mysql, mongo] = await Promise.all([mysqlStatus(), mongoStatus()]);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ok: mysql.ok && mongo.ok,
            service: 'tomori-database-api',
            upTimeS: Math.round(process.uptime()),
            schemaReady: schemaReady(),
            rateLimitBuckets: rateLimitBucketCount(),
            clients: config.tokens.map(t => t.name),
            services: { mysql, mongo },
        });
    });

    // 业务端点: 先认令牌, 再按 client 限流
    app.use(
        '/v1',
        requireToken,
        rateLimit({ scope: 'api', windowMs: 60_000, max: config.rateLimitPerMin }),
        v1Router
    );

    app.use('/v1', (_req, res) => fail(res, 'NOT_FOUND', '接口不存在', 404));
    app.use(errorHandler);

    return app;
}
