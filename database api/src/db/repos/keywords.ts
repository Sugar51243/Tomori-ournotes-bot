import { collection } from '../mongo';
import { AppError } from '../../http/errors';

/**
 * 用户关键词集合(原 bot 的 src/db/mongo.ts keywordsCollection + keywords.ts 的直接操作)。
 * 唯一索引 (entityType, entityId, normKeyword) 由 db/mongo.ts 启动时建好;
 * 归一化(normKeyword)由 bot 侧的搜索库计算后传进来 —— 那是 bot 的领域逻辑。
 */

export async function listAll(): Promise<Array<Record<string, unknown>>> {
    const col = await collection('keywords');
    return col.find({}).sort({ createdAt: 1 }).toArray() as Promise<Array<Record<string, unknown>>>;
}

export async function add(doc: {
    entityType: string;
    entityId: number;
    keyword: string;
    normKeyword: string;
    userId: string;
}): Promise<void> {
    const col = await collection('keywords');
    try {
        await col.insertOne({ ...doc, createdAt: new Date() });
    } catch (e) {
        // 并发上传同一关键词时由唯一索引兜底
        if ((e as { code?: number }).code === 11000) throw AppError.conflict('该关键词已存在');
        throw e;
    }
}

export async function remove(filter: {
    entityType: string;
    entityId: number;
    normKeyword: string;
    userId: string;
}): Promise<number> {
    const col = await collection('keywords');
    const result = await col.deleteOne(filter);
    return result.deletedCount;
}
