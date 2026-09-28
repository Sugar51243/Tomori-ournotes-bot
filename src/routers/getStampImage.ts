import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { middleware } from './middleware';
import { imageBuffer, stampUrl } from '../data/assets';
import { store } from '../data/masterdata';

/**
 * 贴纸原图(无画布加工): 按数字 ID 查询 MasterStamp 并直出 CDN 素材。
 * 端点命名沿用 /getCardIllustration 风格。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('stampId').isNumeric(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { stampId } = req.body;
        try {
            const result = await commandGetStampImage(parseInt(stampId, 10));
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandGetStampImage(stampId: number): Promise<Array<Buffer | string>> {
    await store.refresh();
    const stamp = await store.stampById(stampId);
    if (!stamp) {
        return ['错误: 该贴纸不存在'];
    }
    if (!stamp.stampAsset) {
        return ['错误: 贴纸图片获取失败'];
    }
    const art = await imageBuffer(stampUrl(stamp.stampAsset), `images/stamp/${stampId}.webp`);
    if (!art) {
        return ['错误: 贴纸图片获取失败'];
    }
    return [art];
}

export { router as getStampImageRouter };
