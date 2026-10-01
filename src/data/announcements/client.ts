import { config } from '../../config';
import { cachedFetch } from '../cachedFetch';
import { Server } from '../../types/Server';
import { Announcement } from '../../types/Announcement';

/**
 * 公告客户端(rankd 公开接口, 无鉴权)。
 * 列表带 ETag, 用 cachedFetch 的 revalidate 走 304 重验证 —— 这也是变更检测的基础。
 */

function base(server: Server): string {
    return `${config.gameApiBase}/api/v1/${server}`;
}

function parseList(buf: Buffer): Announcement[] {
    try {
        const body = JSON.parse(buf.toString('utf8')) as { announcements?: unknown };
        if (!Array.isArray(body.announcements)) return [];
        return body.announcements.filter((a): a is Announcement => !!a && typeof (a as Announcement).id === 'string');
    } catch {
        return [];
    }
}

export interface AnnouncementListResult {
    announcements: Announcement[];
    /** 上游是否为陈旧数据(X-Stale: 1) */
    stale: boolean;
}

/**
 * 公告列表; 上游不可用时回退磁盘陈旧副本, 再不行返回空表。
 * @param force 变更检测(轮询)传 true —— 跳过 TTL 直接走 ETag 条件请求, 否则读不到变化
 */
export async function listAnnouncements(server: Server, opts: { force?: boolean } = {}): Promise<AnnouncementListResult> {
    const res = await cachedFetch(`${base(server)}/announcements`, {
        key: `announcements/${server}/list.json`,
        ttlS: config.announcementTtlS,
        allowStale: true,
        revalidate: true,
        forceRefresh: opts.force
    }).catch(() => undefined);
    if (!res) return { announcements: [], stale: true };
    return { announcements: parseList(res.data), stale: res.source === 'stale' };
}

/**
 * 公告详情(含正文 HTML); 找不到返回 undefined。
 * @param force 变更推送(公告刚被新增/修改)传 true —— 跳过 TTL, 免得把最多 ANNOUNCEMENT_TTL_S
 *              之前的旧正文当成新公告推出去
 */
export async function getAnnouncement(server: Server, id: string, opts: { force?: boolean } = {}): Promise<Announcement | undefined> {
    const res = await cachedFetch(`${base(server)}/announcements/${encodeURIComponent(id)}`, {
        key: `announcements/${server}/detail_${id}.json`,
        ttlS: config.announcementTtlS,
        allowStale: true,
        revalidate: true,
        forceRefresh: opts.force
    }).catch(() => undefined);
    if (!res) return undefined;
    try {
        const body = JSON.parse(res.data.toString('utf8')) as { announcement?: Announcement };
        return body.announcement;
    } catch {
        return undefined;
    }
}
