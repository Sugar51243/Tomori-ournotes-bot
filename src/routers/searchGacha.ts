import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServerList, pickServers, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { Gacha } from '../types/Gacha';
import { drawGachaDetail } from '../view/gachaDetail';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').custom(isServerList),
        body('gachaId').isInt(),
        body('useEasyBG').optional().isBoolean(),   // tsugu 兼容, 忽略
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { gachaId, compress } = req.body;
        try {
            const result = await commandGacha(pickServers(req.body), gachaId, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGacha(servers: Server[], gachaId: number, compress: boolean): Promise<Array<Buffer | string>> {
    // 主体取第一个收录该卡池的区域
    let gacha: Gacha | undefined;
    for (const server of servers) {
        const candidate = withServer(new Gacha(gachaId), server);
        await candidate.init();
        if (candidate.isExist) { gacha = candidate; break; }
    }
    if (!gacha) {
        return ['错误: 该卡池不存在'];
    }
    return drawGachaDetail(gacha, compress);
}

export { router as searchGachaRouter };
