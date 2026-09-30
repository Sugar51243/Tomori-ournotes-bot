import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from './utils';
import { isServer, isServerList, pickServers, Server, withServer } from '../types/Server';
import { middleware } from './middleware';
import { refreshRegion, storeFor } from '../data/region';
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
            const result = await commandSongMeta(pickServers(req.body), compress);
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export async function commandSongMeta(servers: Server[], compress: boolean): Promise<Array<Buffer | string>> {
    // 曲目集合取所选服的并集(默认四服时即港澳台 ∪ 日服, 日服独有曲也能列出来);
    // 每首歌实际显示哪一服的一行, 由视图按「港澳台 -> 日服」优先决定
    const songIds: number[] = [];
    for (const server of servers) {
        await refreshRegion(server);
        for (const row of await storeFor(server).songs()) {
            if (!songIds.includes(row.id)) songIds.push(row.id);
        }
    }

    const songs: Song[] = [];
    for (const id of songIds) {
        // 曲目本体(标题/乐队/分类)同样优先港澳台, 无则日服
        const owner = await firstOwner(id, servers);
        const song = withServer(new Song(id), owner);
        await song.init();
        if (!song.isExist) continue;
        // 全歌曲表的时长列: 仅读谱面清单(不含 BPM, 避免为 85 首下载音符文件)
        await song.loadChartInfo(false);
        songs.push(song);
    }
    return drawSongMetaList(songs, servers, compress);
}

/** 该曲本体取哪个服的数据: 港澳台 -> 日服 -> 第一个收录的服 */
async function firstOwner(songId: number, servers: Server[]): Promise<Server> {
    const ordered = [
        ...servers.filter(s => s === 'tw'),
        ...servers.filter(s => s === 'jp'),
        ...servers.filter(s => s !== 'tw' && s !== 'jp')
    ];
    for (const server of ordered) {
        if (await storeFor(server).songById(songId)) return server;
    }
    return servers[0];
}

export { router as songMetaRouter };
