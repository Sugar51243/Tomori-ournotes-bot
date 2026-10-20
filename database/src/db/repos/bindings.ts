import { collection } from '../mongo';

/**
 * 玩家绑定集合(一个 QQ 可绑多个账号; 原 bot 的 bindingsCollection + adapter 绑定段)。
 * 唯一索引 (userId, accountId) + userId 单列索引由 db/mongo.ts 启动时建好。
 *
 * 绑定只做两件事: 免输玩家 ID(默认账号) + 用绑定码证明账号归属。**不放行任何隐藏数据**。
 */

export interface BindingFields {
    userId: string;
    accountId: number;
    playerId: string;
    server: string;
    label?: string;
}

/**
 * 新增/更新一条绑定(按 userId+accountId upsert)。
 * 该用户的**第一个**绑定自动设为默认; 已存在但没有默认的(老数据/异常)也顺手补一个。
 */
export async function add(fields: BindingFields): Promise<void> {
    const col = await collection('bindings');
    const now = new Date();
    const existing = await col.countDocuments({ userId: fields.userId });
    const hasDefault = await col.countDocuments({ userId: fields.userId, isDefault: true });

    const set: Record<string, unknown> = {
        playerId: fields.playerId,
        server: fields.server,
        updatedAt: now,
    };
    const update: Record<string, unknown> = {
        $set: set,
        $setOnInsert: {
            userId: fields.userId,
            accountId: fields.accountId,
            isDefault: existing === 0 || hasDefault === 0,
            createdAt: now,
        },
    };
    if (fields.label) set.label = fields.label;
    else update.$unset = { label: '' };

    await col.updateOne({ userId: fields.userId, accountId: fields.accountId }, update, { upsert: true });
}

/** 某用户的全部绑定: 默认在前, 其余按创建时间 */
export async function list(userId: string): Promise<Array<Record<string, unknown>>> {
    const col = await collection('bindings');
    return col.find({ userId }).sort({ isDefault: -1, createdAt: 1 }).toArray() as Promise<Array<Record<string, unknown>>>;
}

/** 默认绑定(没有默认标记时取最近更新的一条); null = 没有绑定 */
export async function getDefault(userId: string): Promise<Record<string, unknown> | null> {
    const col = await collection('bindings');
    const doc = await col.findOne({ userId, isDefault: true })
        ?? await col.findOne({ userId }, { sort: { updatedAt: -1 } });
    return (doc as Record<string, unknown> | null) ?? null;
}

/** 解绑指定账号; 若删掉的正是默认账号, 把最早的一条提升为默认。返回是否删到了 */
export async function remove(userId: string, accountId: number): Promise<boolean> {
    const col = await collection('bindings');
    const doc = await col.findOneAndDelete({ userId, accountId });
    if (!doc) return false;
    if (doc.isDefault) {
        const next = await col.findOne({ userId }, { sort: { createdAt: 1 } });
        if (next) await col.updateOne({ _id: next._id }, { $set: { isDefault: true, updatedAt: new Date() } });
    }
    return true;
}

/** 切换默认账号; 目标不存在返回 false */
export async function setDefault(userId: string, accountId: number): Promise<boolean> {
    const col = await collection('bindings');
    const target = await col.findOne({ userId, accountId });
    if (!target) return false;
    await col.updateMany({ userId, isDefault: true }, { $set: { isDefault: false, updatedAt: new Date() } });
    await col.updateOne({ userId, accountId }, { $set: { isDefault: true, updatedAt: new Date() } });
    return true;
}
