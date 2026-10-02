import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { getAnnouncement, listAnnouncements } from '../../data/announcements/client';
import { drawAnnouncementList } from '../../view/announcement/announcementList';
import { drawAnnouncementDetail } from '../../view/announcement/announcementDetail';

/**
 * 公告**一次性查询**(单服, 与推送分开的两个接口之一):
 * - 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**
 * - 不传 `id`: 出该服的公告列表图
 * - 传 `id`:   出该条公告的详情图(标题/分类/时间/横幅 + 正文文本)
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // 公告 ID 上游是字符串, 这里 number 与字符串都收
        body('id').optional().custom(v => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))),
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
    /** 公告 ID; 不传 = 出该服的公告列表图 */
    id?: string;
    compress?: boolean;
}

export async function commandAnnouncements(server: Server, query: AnnouncementQuery = {}): Promise<Array<Buffer | string>> {
    const { id, compress = false } = query;
    if (id === undefined) {
        const { announcements } = await listAnnouncements(server);
        return drawAnnouncementList(server, announcements, compress);
    }
    const item = await getAnnouncement(server, id);
    if (!item) {
        return [`错误: 该公告不存在(或该服没有这条公告)`];
    }
    return drawAnnouncementDetail(server, item, compress);
}

export { router as announcementRouter };
