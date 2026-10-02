import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { getAnnouncement, listAnnouncements } from '../../data/announcements/client';
import { Announcement } from '../../types/Announcement';
import { drawAnnouncementList } from '../../view/announcement/announcementList';
import { drawAnnouncementDetail } from '../../view/announcement/announcementDetail';

/**
 * 公告**一次性查询**(单服, 与推送分开的两个接口之一):
 * - 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**
 * - 不传 `id`: 出该服的公告列表图
 * - 传 `id`:   出该条公告的详情图(标题/分类/时间/横幅 + 正文文本)
 * - 传 `id = -1`: 哨兵值 —— 先拉列表挑出该服**最新**的一条公告, 再出它的详情图
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 公告 ID 上游是字符串, 这里 number 与字符串都收; -1(最新公告哨兵)也走这条
        body('id').optional().custom(v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v))),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { id, compress } = req.body;
        try {
            const result = await commandAnnouncements(pickServer(req.body), {
                id: id === undefined ? undefined : String(id),
                compress
            });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface AnnouncementQuery {
    /** 公告 ID; 不传 = 出该服的公告列表图; -1 = 出该服最新一条公告的详情图 */
    id?: string;
    compress?: boolean;
}

/** `id = -1` 不是真实公告 ID, 而是「该服最新公告」的哨兵值 */
const LATEST_ID = '-1';

/** 从列表里挑「最新」的一条: startAt 最大者, 并列时取 id 最大者 */
function pickLatest(announcements: Announcement[]): Announcement | undefined {
    let latest: Announcement | undefined;
    for (const a of announcements) {
        if (!latest) {
            latest = a;
            continue;
        }
        const byStart = Number(a.startAt) - Number(latest.startAt);
        if (byStart > 0 || (byStart === 0 && Number(a.id) > Number(latest.id))) latest = a;
    }
    return latest;
}

export async function commandAnnouncements(server: Server, query: AnnouncementQuery = {}): Promise<Array<Buffer | string>> {
    const { id, compress = false } = query;
    if (id === undefined) {
        const { announcements } = await listAnnouncements(server);
        return drawAnnouncementList(server, announcements, compress);
    }
    // id = -1: 先拉列表挑出最新一条, 再按它的真实 ID 走下面的详情图。
    // 用 force 跳过 TTL —— 问「最新」却拿 TTL 内的旧列表会答错; 有 ETag 兜底, 未变时只是 304。
    const targetId = id === LATEST_ID
        ? pickLatest((await listAnnouncements(server, { force: true })).announcements)?.id
        : id;
    if (targetId === undefined) {
        return ['错误: 该服务器暂无公告'];
    }
    const item = await getAnnouncement(server, targetId);
    if (!item) {
        return [`错误: 该公告不存在(或该服没有这条公告)`];
    }
    return drawAnnouncementDetail(server, item, compress);
}

export { router as announcementRouter };
