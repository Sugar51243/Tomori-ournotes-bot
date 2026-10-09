import { logger, describeError } from './logger';
import { ensureSchema } from './db/schema';
import { ensureCutoffSchema } from './db/cutoffSchema';

/**
 * 建表 + 迁移 + 种子。原先是 web 侧 bootstrap 的职责(每 30s 重试直到成功),
 * 现在建表全部归本服务, 且必须两套 schema 都就绪 —— 榜线表(bot 库)与
 * 平台表(web 库)。失败不阻塞启动, 后台重试: 允许"先起本服务后起 MySQL"。
 */

const RETRY_MS = 30_000;

let done = false;

async function run(): Promise<void> {
    try {
        await ensureCutoffSchema();
        await ensureSchema();
        done = true;
        logger('schema', 'all schemas ready (cutoff + web)');
    } catch (e) {
        logger('schema', `schema init failed, retry in ${RETRY_MS / 1000}s: ${describeError(e)}`, 'warn');
        setTimeout(() => void run(), RETRY_MS).unref?.();
    }
}

/** 幂等; fire-and-forget(与 web 原先的 startBootstrap 行为一致) */
export function startSchemaBootstrap(): Promise<void> {
    if (!done) void run();
    return Promise.resolve();
}

export function schemaReady(): boolean {
    return done;
}
