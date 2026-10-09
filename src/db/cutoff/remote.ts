import { callDbApi } from '../apiClient';
import { logger } from '../../logger';
import { CutoffBackend, CutoffRow, UpsertMode } from './backend';

/**
 * 榜线的「数据库 API」后端(首选存储)。SQL/建表/连接凭据全在 database api
 * 那个独立进程里, 这里只发语义化请求(见 database api/README.md)。
 *
 * 与旧的 MySQL 后端职责完全对齐:
 * - 打开时 ping 一次, 连不上返回 undefined(由 CutoffRuntime 回退 SQLite);
 * - 运行中任何失败原样抛出, 由 runtime 降级 + 退避重试(tryRecover)。
 */

/** 扫描分页大小(与旧 MySQL 后端的 SCAN_BATCH 一致) */
const SCAN_BATCH = 1000;

type ScanCursor = [string, number, number, number, number];

interface ScanPage {
    rows: CutoffRow[];
    next: ScanCursor | null;
}

function describe(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 打开远程后端: 未配置/连不上返回 undefined(由上层回退 SQLite) */
export async function tryOpenRemoteBackend(): Promise<CutoffBackend | undefined> {
    try {
        await callDbApi('cutoff', 'ping');
    } catch (e) {
        logger('cutoff', `database api unavailable, fall back to sqlite: ${describe(e)}`);
        return undefined;
    }

    return {
        kind: 'remote',
        persistent: true,
        async upsertRows(rows: CutoffRow[], mode: UpsertMode) {
            // 行清洗在 API 侧还会再做一次(sanitizeRow 逐字搬过去的)
            await callDbApi('cutoff', 'upsert', { mode, rows });
        },
        async load(server, eventId) {
            return callDbApi<CutoffRow[]>('cutoff', 'load', { server, eventId });
        },
        async *scanAll() {
            let after: ScanCursor | undefined;
            for (;;) {
                const page = await callDbApi<ScanPage>('cutoff', 'scan', {
                    ...(after ? { after } : {}),
                    limit: SCAN_BATCH
                });
                if (!page.rows.length) return;
                yield page.rows;
                if (!page.next) return;
                after = page.next;
                // 让出事件循环, 与旧实现的节奏一致
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        },
        async getMeta(key) {
            const { value } = await callDbApi<{ value: string | null }>('cutoff', 'metaGet', { key });
            return value ?? undefined;
        },
        async setMeta(key, value) {
            await callDbApi('cutoff', 'metaSet', { key, value });
        },
        async ping() {
            await callDbApi('cutoff', 'ping');
        },
        async close() {
            /* HTTP 无长连接需要关闭 */
        }
    };
}
