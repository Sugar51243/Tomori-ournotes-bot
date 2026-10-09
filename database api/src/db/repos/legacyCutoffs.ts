import { ObjectId } from 'mongodb';
import { collection } from '../mongo';

/**
 * 旧榜线集合(`cutoffs`)的只读分页扫描 —— 供 bot 把 Mongo 时代的榜线历史
 * 一次性迁移进当前存储(见 bot 的 src/db/cutoff/runtime.ts)。
 *
 * 与社区集合不同, 这条路径**不看 ENABLE_DB**(社区功能开关), 只要有人来扫就给 ——
 * 旧数据可能来自当时开过 ENABLE_DB 的部署。只读, 不建索引, 不写数据。
 */

export interface LegacyScanPage {
    docs: Array<Record<string, unknown>>;
    /** 下一页游标(ObjectId 十六进制串); null = 已取完 */
    next: string | null;
}

/** 按 _id 升序游标分页(与旧 Mongo 驱动的 find({}).batchSize(1000) 同序); 集合为空 = 空页 */
export async function scan(afterId: string | undefined, limit: number): Promise<LegacyScanPage> {
    const col = await collection('cutoffs');
    const filter = afterId ? { _id: { $gt: new ObjectId(afterId) } } : {};
    const docs = await col.find(filter).sort({ _id: 1 }).limit(limit).toArray();
    const last = docs[docs.length - 1];
    return {
        docs: docs as Array<Record<string, unknown>>,
        next: docs.length < limit || !last ? null : String(last._id),
    };
}
