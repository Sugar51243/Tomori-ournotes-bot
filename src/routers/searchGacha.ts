import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServerList } from '../types/Server';
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
            const result = await commandGacha(gachaId, compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGacha(gachaId: number, compress: boolean): Promise<Array<Buffer | string>> {
    const gacha = new Gacha(gachaId);
    await gacha.init();
    if (!gacha.isExist) {
        return ['错误: 该卡池不存在'];
    }
    return drawGachaDetail(gacha, compress);
}

export { router as searchGachaRouter };
