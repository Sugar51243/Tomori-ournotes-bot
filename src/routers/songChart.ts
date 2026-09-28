import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServerList } from '../types/Server';
import { middleware } from './middleware';
import { drawSongChart } from '../view/songChart';
import { NOTE_SPEED_DEFAULT, NOTE_SPEED_MIN, NOTE_SPEED_MAX } from '../components/OurNotesPreview';

const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').custom(isServerList),
        body('songId').isInt(),
        body('difficultyId').optional().isInt({ min: 0, max: 3 }),
        body('compress').optional().isBoolean(),
        body('mirror').optional().isBoolean(),
        // 预览流速(音符速度): 沿用来源的 NoteSpeed 规则(默认 5.00, 范围 1.00~12.00),
        // 数值越高谱面拉得越长、音符间距越大。speed 为同义别名。
        body('noteSpeed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
        body('speed').optional().isFloat({ min: NOTE_SPEED_MIN, max: NOTE_SPEED_MAX }),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { songId, difficultyId = 3, compress, mirror = false, noteSpeed, speed } = req.body;
        const resolvedSpeed = noteSpeed ?? speed ?? NOTE_SPEED_DEFAULT;
        try {
            const result = await drawSongChart(songId, difficultyId, compress, mirror, resolvedSpeed);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export { router as songChartRouter };
