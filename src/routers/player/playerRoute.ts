import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { hasServerInput, isServerInput, pickServer, Server } from '../../types/Server';
import { middleware } from '../middleware';
import { getPlayerProfile } from '../../data/player/client';
import { drawPlayerProfile } from '../../view/player/playerProfile';
import {
    inferServerFromPlayerId, isValidPlayerId,
    PlayerNotFoundError, PlayerUnavailableError
} from '../../types/Player';

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
        body('playerId').custom(v => typeof v === 'number' || (typeof v === 'string' && /^\d{1,19}$/.test(v))),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { playerId, compress } = req.body;
        try {
            const result = await commandSearchPlayer(req.body, String(playerId), compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSearchPlayer(body_: unknown, playerId: string, compress: boolean): Promise<Array<Buffer | string>> {
    const body = (body_ ?? {}) as Record<string, unknown>;
    // 未显式指定服务器时, 按 ID 首位推断(2->tw / 3->en / 4->kr); JP 没有前缀规则, 必须显式传
    const explicit = hasServerInput(body);
    const server: Server = explicit ? pickServer(body) : (inferServerFromPlayerId(playerId) ?? pickServer(body));

    if (!isValidPlayerId(server, playerId)) {
        return [`错误: 该 ID 不符合 ${server} 服的账号格式`];
    }

    try {
        const profile = await getPlayerProfile(server, playerId);
        return drawPlayerProfile(server, profile, compress);
    } catch (e) {
        if (e instanceof PlayerNotFoundError) return [`错误: ${e.message}`];
        if (e instanceof PlayerUnavailableError) return [`错误: ${e.message}`];
        throw e;
    }
}

export { router as playerRouter };
