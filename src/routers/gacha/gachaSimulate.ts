import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServer, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { Gacha } from '../../types/Gacha';
import { simulateGacha, getCurrentGacha } from '../../gacha/simulate';
import { drawGachaSimulate } from '../../view/gacha/gachaSimulate';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('times').optional().isInt({ min: 1 }),
        body('compress').optional().isBoolean(),
        body('gachaId').optional().isInt(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { times = 10, compress, gachaId } = req.body;
        try {
            const result = await commandGachaSimulate(pickServer(req.body), gachaId, times, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGachaSimulate(server: Server, gachaId: number | undefined, times: number, compress: boolean): Promise<Array<Buffer | string>> {
    if (times > 10000) {
        return ['错误: 抽卡次数过多, 请不要超过10000次'];
    }

    let gacha: Gacha | undefined;
    if (gachaId !== undefined) {
        gacha = withServer(new Gacha(gachaId), server);
        await gacha.init();
        if (!gacha.isExist) {
            return ['错误: 该卡池不存在'];
        }
    } else {
        gacha = await getCurrentGacha(server);
        if (!gacha) {
            return ['错误: 该服务器没有正在进行的卡池'];
        }
    }

    const results = await simulateGacha(gacha, times);
    return drawGachaSimulate(gacha.gachaName, results, compress);
}

export { router as gachaSimulateRouter };
