import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput } from '../../features/types/Server';
import { middleware } from '../middleware';
import { commandSearchPlayer } from '../../features/player/playerRoute';

/**
 * 账号查询(/searchPlayer, tsugu 对应端点)。
 *
 * 这是**用户动态数据**: 一次只查一个服, 服务器取 `displayedServerList` 的**首个**(单值即该服),
 * **不允许回退**。tsugu 文档把 playerId 声明为 number, 而本项目交友接口用纯数字字符串 ——
 * 这里两者都接受, 内部统一转成十进制字符串再拼 URL。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        // number 与纯数字字符串都接受(tsugu 传 number, 本项目交友接口传字符串)
        // playerId 可省略 = 用默认绑定(userId 指定); 两者至少要有一个, 由 feature 层给文案
        body('playerId').optional().custom(v => v === undefined || typeof v === 'number' || (typeof v === 'string' && /^\d{1,19}$/.test(v))),
        body('userId').optional().isString().isLength({ min: 1, max: 32 }),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        try {
            const result = await commandSearchPlayer(req.body);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as playerRouter };
