import { logger } from '../../logger';
import { CutoffBackend, CutoffRow, rowKey, sanitizeRow } from './backend';

/**
 * 数据迁移/回灌:
 * - migrateMongoToBackend: MongoDB 的旧榜线文档 → 当前后端(只读源、merge 写入, 幂等)
 * - syncToMysql: SQLite 降级缓冲 → MySQL(merge 写入, 幂等)
 *
 * 都用 merge 模式 + 批内按主键去重 —— 重跑安全, 且不会用旧数据覆盖更新的数据。
 */

const BATCH = 500;

/** Mongo 文档 → 存储行(旧数据形状可能很脏, 清洗后非法行丢弃) */
export function mapMongoDocToRow(doc: unknown): CutoffRow | undefined {
    if (!doc || typeof doc !== 'object') return undefined;
    const d = doc as Record<string, unknown>;
    return sanitizeRow({
        server: typeof d.server === 'string' ? d.server : String(d.server ?? ''),
        eventId: Number(d.eventId),
        musicId: Number(d.musicId),
        tier: Number(d.tier),
        bucket: Number(d.bucket),
        score: Number(d.score),
        recordedAt: d.recordedAt === undefined || d.recordedAt === null ? undefined : Number(d.recordedAt),
        upstreamAt: d.upstreamAt === undefined || d.upstreamAt === null ? undefined : Number(d.upstreamAt)
    });
}

/** 批内按主键去重: 同一 PK 只留 recordedAt 更大的那条 */
function dedupe(rows: CutoffRow[]): CutoffRow[] {
    const byKey = new Map<string, CutoffRow>();
    for (const row of rows) {
        const key = rowKey(row);
        const prev = byKey.get(key);
        if (!prev || (row.recordedAt ?? 0) >= (prev.recordedAt ?? 0)) byKey.set(key, row);
    }
    return [...byKey.values()];
}

const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** 把一批行 merge 进目标后端(自动清洗/去重), 返回写入条数 */
async function flush(target: CutoffBackend, rows: CutoffRow[]): Promise<number> {
    const clean = rows.map(sanitizeRow).filter((r): r is CutoffRow => r !== undefined);
    const deduped = dedupe(clean);
    if (deduped.length) await target.upsertRows(deduped, 'merge');
    return deduped.length;
}

/**
 * MongoDB 旧文档 → 目标后端。
 * marker 由调用方在**整个流成功之后**写入, 中途失败下次启动重跑(merge 幂等)。
 */
export async function migrateMongoToBackend(
    target: CutoffBackend,
    docs: AsyncIterable<unknown>,
    batchSize = BATCH
): Promise<number> {
    let total = 0;
    let skipped = 0;
    let batch: CutoffRow[] = [];
    for await (const doc of docs) {
        const row = mapMongoDocToRow(doc);
        if (!row) {
            skipped++;
            continue;
        }
        batch.push(row);
        if (batch.length >= batchSize) {
            total += await flush(target, batch);
            batch = [];
            await yieldLoop();
        }
    }
    total += await flush(target, batch);
    if (skipped > 0) {
        logger('cutoff', `mongo migration: skipped ${skipped} invalid doc(s)`);
    }
    return total;
}

/** SQLite 缓冲 → MySQL(merge 幂等; 返回写入条数) */
export async function syncToMysql(source: CutoffBackend, target: CutoffBackend, batchSize = BATCH): Promise<number> {
    let total = 0;
    for await (const rows of source.scanAll()) {
        for (let i = 0; i < rows.length; i += batchSize) {
            total += await flush(target, rows.slice(i, i + batchSize));
        }
        await yieldLoop();
    }
    return total;
}
