import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandAnnouncements } from '../../features/announcement/announcementRoute';

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

export { router as announcementRouter };
