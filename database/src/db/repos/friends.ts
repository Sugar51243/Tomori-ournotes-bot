import { collection } from '../mongo';

/**
 * 交友集合(原 bot 的 src/db/mongo.ts friendsCollection + adapter, 以及 web 的 friendRepo)。
 * userId 唯一索引由 db/mongo.ts 启动时建好; 网页用户在 bot 侧的身份是 `web:<id>` 前缀。
 *
 * 写入复刻两边的既有契约: userName/playerId/server/updatedAt 必写, avatarUrl 缺省即 $unset
 * (网页侧先例; bot 的读取侧对 null/缺省一视同仁)。
 */

/** 搜索词进正则前的转义(两边调用方原来各自转, 现在服务端统一做) */
export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function list(): Promise<Array<Record<string, unknown>>> {
    const col = await collection('friends');
    return col.find({}).sort({ updatedAt: -1 }).toArray() as Promise<Array<Record<string, unknown>>>;
}

export async function get(userId: string): Promise<Record<string, unknown> | null> {
    const col = await collection('friends');
    return (await col.findOne({ userId })) as Record<string, unknown> | null;
}

export async function upsert(fields: {
    userId: string;
    userName: string;
    avatarUrl?: string;
    playerId: string;
    server: string;
}): Promise<void> {
    const col = await collection('friends');
    const now = new Date();
    const set: Record<string, unknown> = {
        userName: fields.userName,
        playerId: fields.playerId,
        server: fields.server,
        updatedAt: now,
    };
    // 头像: 给了就写, 没给就清掉(与 web 侧原语义一致); 单条 update 里 $set/$unset 并存
    if (fields.avatarUrl) set.avatarUrl = fields.avatarUrl;
    const update: Record<string, unknown> = {
        $set: set,
        $setOnInsert: { userId: fields.userId, createdAt: now },
    };
    if (!fields.avatarUrl) update.$unset = { avatarUrl: '' };

    await col.updateOne({ userId: fields.userId }, update, { upsert: true });
}

export async function search(pattern: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const col = await collection('friends');
    const re = new RegExp(escapeRegex(pattern), 'i');
    return col
        .find({ $or: [{ userName: re }, { playerId: re }] })
        .limit(limit)
        .toArray() as Promise<Array<Record<string, unknown>>>;
}

export async function remove(userId: string): Promise<number> {
    const col = await collection('friends');
    const result = await col.deleteOne({ userId });
    return result.deletedCount;
}
