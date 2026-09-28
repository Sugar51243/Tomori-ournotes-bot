import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServer, isServerList } from '../types/Server';
import { middleware } from './middleware';
import { store } from '../data/masterdata';
import { Song } from '../types/Song';
import { drawSongMetaList } from '../view/songMetaList';

const router = express.Router();

router.post('/',
    [
        body('displayedServerList').custom(isServerList),
        body('mainServer').custom(isServer),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { compress } = req.body;
        try {
            const result = await commandSongMeta(compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSongMeta(compress: boolean): Promise<Array<Buffer | string>> {
    const rows = await store.songs();
    const songs: Song[] = [];
    for (const row of rows) {
        const song = new Song(row.id);
        await song.init();
        // 全歌曲表的时长列: 仅读谱面清单(不含 BPM, 避免为 85 首下载音符文件)
        await song.loadChartInfo(false);
        songs.push(song);
    }
    return drawSongMetaList(songs, compress);
}

export { router as songMetaRouter };
