import { collection } from '../mongo';
import { config } from '../../config';
import { AppError } from '../../http/errors';
import { escapeRegex } from './friends';

/**
 * 车站集合(原 bot 的 stationsCollection + adapter.submitStationRoom, 以及 web 的 stationRepo)。
 *
 * 三个字段一个都不能少: time(客户端原值)/timeMs(归一到毫秒, 排序用)/
 * expireAt(TTL 索引字段; 漏写会让记录永不过期, 且读侧 expireAt > now 过滤会让它对所有人不可见)。
 * expireAt 由本服务按 config.stationTtlS 计算 —— TTL 常量从此只此一处。
 */

/** 未过期房间: 按归一秒值倒序(老数据没有 timeMs 时退回 time) */
export async function listActive(): Promise<Array<Record<string, unknown>>> {
    const col = await collection('stations');
    return col
        .find({ expireAt: { $gt: new Date() } })
        .sort({ timeMs: -1, time: -1 })
        .toArray() as Promise<Array<Record<string, unknown>>>;
}

/**
 * 按房号或留言搜索当前未过期的房间(社区快速搜索用)。
 * 传进来的如果是纯数字, 顺带按房号精确匹配一次 —— 用户十有八九是想找某个具体房间。
 */
export async function search(pattern: string, numeric: number | undefined, limit: number): Promise<Array<Record<string, unknown>>> {
    const col = await collection('stations');
    const re = new RegExp(escapeRegex(pattern), 'i');
    const or: Record<string, unknown>[] = [{ rawMessage: re }, { userName: re }];
    if (numeric !== undefined) or.push({ number: numeric });

    return col
        .find({ expireAt: { $gt: new Date() }, $or: or })
        .sort({ timeMs: -1 })
        .limit(limit)
        .toArray() as Promise<Array<Record<string, unknown>>>;
}

export interface SubmitStationFields {
    number: number;
    rawMessage: string;
    source: string;
    /** 网页身份 `web:<账号ID>` 或 QQ 号 */
    userId: string;
    userName: string;
    /** 客户端上报的原始时间(保留原单位) */
    time: number;
    /** 归一到毫秒 */
    timeMs: number;
    avatarUrl?: string;
}

/**
 * 提交/刷新房号。
 *
 * `claim` 区分两侧的既有语义:
 * - false(bot): 谁提交都覆盖 —— filter 只有 number, 同房号直接刷新;
 * - true(web): 只能刷新自己提交的房号(filter 带 userId), 撞上别人的房号走插入 → 唯一索引 11000
 *   → CONFLICT, 免得任何登录用户都能把别人正在招人的房号改成垃圾文本。
 */
export async function submit(fields: SubmitStationFields, claim: boolean): Promise<void> {
    const col = await collection('stations');
    const now = new Date();
    const doc: Record<string, unknown> = {
        number: fields.number,
        rawMessage: fields.rawMessage,
        source: fields.source,
        userId: fields.userId,
        userName: fields.userName,
        time: fields.time,
        timeMs: fields.timeMs,
        expireAt: new Date(now.getTime() + config.stationTtlS * 1000),
    };
    if (fields.avatarUrl) doc.avatarUrl = fields.avatarUrl;

    const filter = claim ? { number: fields.number, userId: fields.userId } : { number: fields.number };
    try {
        await col.updateOne(filter, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
    } catch (e) {
        if ((e as { code?: number }).code === 11000) {
            throw AppError.conflict('这个房号已经被别人提交了；房号两分半后自动过期，稍后再试或换一个');
        }
        throw e;
    }
}

/** 只能撤下自己提交的房号; force(管理员)跳过归属检查 */
export async function deleteOwned(number: number, userId: string, force = false): Promise<boolean> {
    const col = await collection('stations');
    const result = await col.deleteOne(force ? { number } : { number, userId });
    return result.deletedCount > 0;
}
