import { config } from '../../config';
import { logger } from '../../logger';
import { Server } from '../../types/Server';
import { Announcement } from '../../types/Announcement';
import { getAnnouncement, listAnnouncements } from './client';

/**
 * 公告变更监视器。
 *
 * 上游**没有推送能力**, 只有 ETag/304 与 lastUpdatedAt —— 所以这里用轮询 + 本地 diff,
 * 延迟等于 ANNOUNCEMENT_POLL_S。只轮询「当前有订阅者的区域」, 没人听就不打上游。
 */

/**
 * 只广播「新增」与「修改」—— 下架不推(需要完整列表的客户端走一次性接口)。
 * 下架仍会被 diff 出来用于更新基线, 只是不发事件。
 */
export type AnnouncementEvent = { kind: 'added' | 'updated'; announcement: Announcement };

export type AnnouncementListener = (event: AnnouncementEvent) => void;

/** 每个区域的基线: id -> lastUpdatedAt */
const snapshots = new Map<Server, Map<string, string>>();
const timers = new Map<Server, NodeJS.Timeout>();
const listeners = new Map<Server, Set<AnnouncementListener>>();

function listenersFor(server: Server): Set<AnnouncementListener> {
    let set = listeners.get(server);
    if (!set) {
        set = new Set();
        listeners.set(server, set);
    }
    return set;
}

/**
 * 列表接口**不返回正文**(`Announcement.body` 只有详情接口才给), 而推送出去的是公告详情图。
 * 所以广播前必须按 id 补一次详情请求, 否则每次推送都会画成「该公告没有正文」。
 * 详情取不到时退回列表项 —— 宁可推一张缺正文的图, 也不要因为上游抖动而漏推。
 */
async function withAnnouncementBody(server: Server, listItem: Announcement): Promise<Announcement> {
    try {
        const detail = await getAnnouncement(server, listItem.id, { force: true });
        return detail ? { ...listItem, ...detail } : listItem;
    } catch {
        return listItem;
    }
}

/**
 * 拉一次并与基线对比。
 * @param emit 为 false 时只更新基线(用于首连建立基线, 避免把历史公告当成新增推给刚连上的客户端)
 */
export async function pollAnnouncements(server: Server, emit: boolean): Promise<void> {
    // 必须强制刷新: 轮询间隔与缓存 TTL 同量级, 读缓存命中就永远看不到变更
    const { announcements } = await listAnnouncements(server, { force: true });
    // 上游拉失败/空列表时不覆盖基线: 空列表更可能是上游抖动, 会把全部公告误判成「下架」
    if (announcements.length === 0 && emit) return;

    const previous = snapshots.get(server);
    const next = new Map<string, string>();
    for (const a of announcements) next.set(a.id, a.lastUpdatedAt ?? '');

    if (previous && emit) {
        const changes: AnnouncementEvent[] = [];
        for (const a of announcements) {
            const before = previous.get(a.id);
            if (before === undefined) {
                changes.push({ kind: 'added', announcement: a });
            } else if (before !== a.lastUpdatedAt) {
                changes.push({ kind: 'updated', announcement: a });
            }
        }
        // 下架仅用于更新基线(见上), 不广播
        if (changes.length > 0) {
            const subscribers = listenersFor(server);
            // 多条变更并行补正文, 避免串行等待拖慢推送
            const filled = await Promise.all(changes.map(async c => ({
                kind: c.kind,
                announcement: await withAnnouncementBody(server, c.announcement)
            } as AnnouncementEvent)));
            for (const event of filled) subscribers.forEach(fn => fn(event));
        }
    }
    snapshots.set(server, next);
}

/** 订阅某区域的公告变更; 返回退订函数 */
export function subscribe(server: Server, listener: AnnouncementListener): () => void {
    const set = listenersFor(server);
    set.add(listener);
    startWatching(server);
    return () => {
        set.delete(listener);
        if (set.size === 0) stopWatching(server);
    };
}

function startWatching(server: Server): void {
    if (timers.has(server)) return;
    logger('announcements', `[${server}] start polling every ${config.announcementPollS}s`);
    // 首连先静默建立基线, 之后才开始广播
    void pollAnnouncements(server, false).catch(e => {
        logger('announcements', `[${server}] baseline poll failed: ${e instanceof Error ? e.message : e}`);
    });
    const timer = setInterval(() => {
        void pollAnnouncements(server, true).catch(e => {
            logger('announcements', `[${server}] poll failed: ${e instanceof Error ? e.message : e}`);
        });
    }, Math.max(5, config.announcementPollS) * 1000);
    timer.unref?.();
    timers.set(server, timer);
}

function stopWatching(server: Server): void {
    const timer = timers.get(server);
    if (timer) {
        clearInterval(timer);
        timers.delete(server);
    }
    snapshots.delete(server);
    logger('announcements', `[${server}] no subscribers left, stop polling`);
}
