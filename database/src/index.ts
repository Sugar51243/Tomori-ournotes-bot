import https from 'node:https';
import { config, assertConfig } from './config';
import { logger, describeError } from './logger';
import { createApp } from './app';
import { loadTlsConfig } from './http/tls';
import { startSchemaBootstrap } from './bootstrap';
import { warmMongo } from './db/mongo';
import { closeMysql } from './db/mysql';
import { closeMongo } from './db/mongo';

/**
 * 进程兜底：未捕获异常 / 未处理的 Promise 拒绝不该把数据库服务带走。
 */
process.on('uncaughtException', e => logger('process', `未捕获异常（已兜住，未退出）: ${describeError(e)}`, 'error'));
process.on('unhandledRejection', e => logger('process', `未处理的 Promise 拒绝（已兜住）: ${describeError(e)}`, 'error'));

async function main(): Promise<void> {
    assertConfig();

    const app = createApp();
    // 主端口绑不上(被占/无权限)时不能靠 uncaughtException 兜底假装活着 ——
    // 那样进程不退但一个请求都不收, 对消费方是不可诊断的假死。直接退出让守护进程重启。
    // 控制台窗口标题(Windows 上 process.title 即设置控制台标题): 便于按标题精确定位/结束进程,
// 避免 taskkill /IM node.exe 误杀所有 Node 实例 —— 见根 README「进程管理与防误杀」。
try {
    process.title = `Tomori Database API [${config.port}]`;
} catch { /* 个别平台不支持则忽略 */ }

const server = app.listen(config.port, config.location);
    server.on('error', e => {
        logger('app', `监听 ${config.location}:${config.port} 失败: ${describeError(e)}`, 'error');
        process.exit(1);
    });
    server.on('listening', () => {
        logger('app', `listening on ${config.location}:${config.port} (env=${config.nodeEnv}, clients=${config.tokens.map(t => t.name).join('/') || '无'})`);
        const loopback = (loc: string): boolean => /^127\.|^localhost$/i.test(loc);
        if (!loopback(config.location)) {
            logger(
                'app',
                '明文端口正在对外监听！公网部署请确认：1) 挂了 https（DB_API_HTTPS_PORT 或反代）' +
                    '2) DB_API_TOKENS 是强随机串 3) 配了 DB_API_IP_ALLOWLIST / 防火墙 4) DB_API_TRUST_PROXY 与反代层数一致',
                'warn'
            );
        }
    });

    // 自带 https 监听(可选): 证书读不到/绑不上就只少一个监听, http 照常
    const tls = loadTlsConfig();
    let httpsServer: https.Server | undefined;
    if (tls) {
        try {
            httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
            httpsServer.on('error', e => logger('tls', `https 监听启动失败: ${describeError(e)} —— 只保留 http`, 'warn'));
            httpsServer.listen(tls.port, config.httpsLocation, () => logger('tls', `https 监听就绪: ${config.httpsLocation}:${tls.port}`));
        } catch (e) {
            logger('tls', `https 监听启动失败: ${describeError(e)} —— 只保留 http`, 'warn');
        }
    }

    // 建表/迁移/建索引: 失败不阻塞启动, 后台每 30s 重试
    void startSchemaBootstrap();
    void warmMongo();

    const shutdown = (signal: string): void => {
        logger('app', `收到 ${signal}，正在关闭…`);
        httpsServer?.close();
        server.close(() => {
            void Promise.all([closeMysql(), closeMongo()]).finally(() => process.exit(0));
        });
        // 兜底: 10 秒还没关干净就强退, 免得卡住重启流程
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
    logger('app', `启动失败: ${describeError(e)}`, 'error');
    process.exit(1);
});
