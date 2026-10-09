import express from 'express';
import { config } from '../../config';
import { logger } from '../../logger';
import { SERVER_LIST, Server } from '../../features/types/Server';
import { Announcement } from '../../features/types/Announcement';
import { subscribe } from '../../tasks/announcements/watcher';
import { drawAnnouncementDetail } from '../../render/view/announcement/announcementDetail';
import { listToBase64 } from '../utils';

/**
 * 公告**推流**(SSE, 与一次性查询分开的两个接口之二)。
 *
 * **按服务器分成四条独立端点** `/announcementStream/{tw|jp|kr|en}`, 每条指向一个服,
 * 各自独立的订阅者集合与轮询触发。
 *
 * 只在公告**新增或修改**时推送该条公告的内容图 —— 连接时不发任何快照,
 * 下架也不推(需要全量列表请用一次性接口 `POST /announcements`)。
 *
 * 上游没有推送能力, 更新来自轮询 + 本地 diff, 延迟等于 ANNOUNCEMENT_POLL_S。
 */

type Images = Array<{ type: string; string: string }>;

/**

 * 键里带 lastUpdatedAt: 公告被修改后是新键, 不会命中旧图。
 * 缓存的是 Promise, 所以同时到达的多个订阅者也只渲染一次(单飞)。
 */
const imageCache = new Map<string, Promise<Images>>();
const IMAGE_CACHE_MAX = 16;

/// 渲染公告详情图, 并缓存结果
function renderImages(server: Server, announcement: Announcement): Promise<Images> {
    // 键里带 lastUpdatedAt: 公告被修改后是新键, 不会命中旧图。
    const key = `${server}:${announcement.id}:${announcement.lastUpdatedAt ?? ''}`;
    const hit = imageCache.get(key);
    if (hit) return hit;
    // 直接引用 drawAnnouncementDetail + listToBase64, 不再包一层 commandAnnouncements, 避免重复拉详情
    const task = drawAnnouncementDetail(server, announcement, true)
        .then(listToBase64)
        .catch(e => {
            // 渲染失败不留在缓存里, 下次推送重试
            imageCache.delete(key);
            throw e;
        });
    imageCache.set(key, task);
    // 缓存上限: 超过时删掉最旧的, 让 GC 回收
    if (imageCache.size > IMAGE_CACHE_MAX) {
        const oldest = imageCache.keys().next().value;
        if (oldest !== undefined) imageCache.delete(oldest);
    }
    return task;
}

/// 发送 SSE 事件
function send(res: express.Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/// 处理 SSE 连接的中间件
function handleStream(server: Server): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        // 升级建立至SSE
        res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // 让 nginx 之类的反代不要缓冲, 否则事件会被攒着不发
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();
        // 每个客户端独立订阅(订阅者集合是 Set, 天然支持多客户端同时在线), 退订走下面的 cleanup
        // subscribe函数为注册轮询，返回unsubscribe函数
        const unsubscribe = subscribe(server, async event => {
            try {
                const images = await renderImages(server, event.announcement);
                send(res, 'announcement', {
                    server,
                    kind: event.kind,
                    id: event.announcement.id,
                    title: event.announcement.title,
                    category: event.announcement.category,
                    updatedAt: event.announcement.lastUpdatedAt,
                    images
                });
            } catch (e) {
                logger('announcementStream', `[${server}] push failed: ${e instanceof Error ? e.message : e}`);
            }
        });
        // 心跳: 保活连接, 避免客户端/反代/上游断开, 也避免客户端 SSE 超时重连
        const heartbeat = setInterval(() => {
            // 注释行: 既保活又不触发客户端事件; 写失败(客户端已消失)时清理, 避免空转
            try {
                res.write(': ping\n\n');
            } catch {
                cleanup();
            }
        }, Math.max(5, config.sseHeartbeatS) * 1000);
        heartbeat.unref?.();

        // 握手事件: 只说明连接已就绪与轮询间隔, 不携带公告内容
        res.write(`event: ready\ndata: ${JSON.stringify({ server, pollSeconds: config.announcementPollS })}\n\n`);

        /** 断线清理(幂等): 心跳 + 退订 + 缓存里最后一帧的引用一并释放 */
        let cleaned = false;
        function cleanup(): void {
            if (cleaned) return;
            cleaned = true;
            clearInterval(heartbeat);
            unsubscribe();
        }
        // close 在多数运行时都会来; error 覆盖客户端 RST / 反代断开等只报错不报 close 的情况
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
    };
}

/** 四条固定路径, 每个服一条 */
export function createAnnouncementStreamRouter(): express.Router {
    const router = express.Router();
    for (const server of SERVER_LIST) {
        router.get(`/${server}`, handleStream(server));
    }
    router.get('/', (_req, res) => {
        res.status(404).json({
            status: 'failed',
            data: `参数错误: 请使用 /announcementStream/{${SERVER_LIST.join('|')}}`
        });
    });
    return router;
}
