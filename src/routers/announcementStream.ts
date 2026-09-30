import express from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { SERVER_LIST, Server } from '../types/Server';
import { Announcement } from '../types/Announcement';
import { subscribe } from '../data/announcements/watcher';
import { drawAnnouncementDetail } from '../view/announcementDetail';
import { listToBase64 } from './utils';

/**
 * 公告**推流**(SSE, 与一次性查询分开的两个接口之二)。
 *
 * **按服务器分成四条独立端点** `/announcementStream/{tw|jp|kr|en}`, 每条只服务一个服,
 * 各自独立的订阅者集合与轮询触发。
 *
 * 只在公告**新增或修改**时推送该条公告的内容图 —— 连接时不发任何快照,
 * 下架也不推(需要全量列表请用一次性接口 `POST /announcements`)。
 *
 * 上游没有推送能力, 更新来自轮询 + 本地 diff, 延迟等于 ANNOUNCEMENT_POLL_S。
 */

/** 单条公告的图(base64 数组, 与其它接口同一套 {type,string} 结构) */
async function renderImages(server: Server, announcements: Announcement[]): Promise<Array<{ type: string; string: string }>> {
    if (announcements.length === 0) return [];
    const buffers = await drawAnnouncementDetail(server, announcements[0], true);
    return listToBase64(buffers);
}

function send(res: express.Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleStream(server: Server): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // 让 nginx 之类的反代不要缓冲, 否则事件会被攒着不发
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();

        const unsubscribe = subscribe(server, async event => {
            try {
                send(res, 'announcement', {
                    server,
                    kind: event.kind,
                    id: event.announcement.id,
                    title: event.announcement.title,
                    category: event.announcement.category,
                    updatedAt: event.announcement.lastUpdatedAt,
                    images: await renderImages(server, [event.announcement])
                });
            } catch (e) {
                logger('announcementStream', `[${server}] push failed: ${e instanceof Error ? e.message : e}`);
            }
        });

        const heartbeat = setInterval(() => {
            // 注释行: 既保活又不触发客户端事件
            res.write(': ping\n\n');
        }, Math.max(5, config.sseHeartbeatS) * 1000);
        heartbeat.unref?.();

        // 握手事件: 只说明连接已就绪与轮询间隔, 不携带公告内容
        res.write(`event: ready\ndata: ${JSON.stringify({ server, pollSeconds: config.announcementPollS })}\n\n`);

        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
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
