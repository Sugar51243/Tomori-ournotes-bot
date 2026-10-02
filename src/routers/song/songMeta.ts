import express from 'express';
import { body } from 'express-validator';
import { listToBase64 } from '../utils';
import { isServerInput, pickServers, SERVER_LIST, Server, withServer } from '../../types/Server';
import { middleware } from '../middleware';
import { storeFor } from '../../data/region';
import { Song } from '../../types/Song';
import { getMusicData, rankCharts } from '../../data/musicData/client';
import { drawSongMetaList } from '../../view/song/songMetaList';

/**
 * 歌曲meta · 效率排行(参考站点「歌曲meta」的算法, 数据与其同源)。
 *
 * 一图两榜: 击奏live 与 自由live 各自效率(分/综合力/分钟)最高的前 15 张谱面,
 * 难度**四难度混排**(EZ/NM/HD/EX 一起参与排行), 时长取 BGM 时长。
 *
 * 效率数值与服务器无关(同一份谱面模拟数据), 服务器的选择只决定曲名/乐团的显示语言
 * 与封面的取图区域 —— 沿用「曲目本体优先港澳台, 无则日服」的规则。
 */
const router = express.Router();

router.post(
    '/',
    [
        body('displayedServerList').optional().custom(isServerInput),
        body('compress').optional().isBoolean(),
    ],
    middleware,
    async (req: express.Request, res: express.Response) => {
        const { compress } = req.body;
        try {
            const result = await commandSongMeta(pickServers(req.body), { compress });
            res.send(listToBase64(result));
        } catch (e) {
            console.log(e);
            res.status(500).send({ status: 'failed', data: '内部错误' });
        }
    }
);

export interface SongMetaQuery {
    compress?: boolean;
}

export async function commandSongMeta(servers: Server[], query: SongMetaQuery = {}): Promise<Array<Buffer | string>> {
    const { compress = false } = query;
    const bodyServer = servers[0];
    const data = await getMusicData();
    if (!data) return ['错误: 谱面效率数据暂不可用, 请稍后再试'];

    const battle = rankCharts(data, 'battle', 15);
    const free = rankCharts(data, 'free', 15);

    // 曲目本体(标题/乐团/封面)按所选服取: 港澳台 -> 日服 -> 第一个收录的服
    const ids = [...new Set([...battle, ...free].map(r => r.musicId))];
    const songs = new Map<number, Song>();
    for (const id of ids) {
        const song = withServer(new Song(id), await firstOwner(id, servers));
        await song.init();
        if (song.isExist) songs.set(id, song);
    }

    return drawSongMetaList(bodyServer, battle, free, songs, compress);
}

/** 该曲本体取哪个服的数据: 输入的服按顺序优先, 其次港澳台 -> 日服 -> 其余 */
async function firstOwner(songId: number, servers: Server[]): Promise<Server> {
    const ordered = [
        ...servers,
        ...SERVER_LIST.filter(s => (s === 'tw' || s === 'jp') && !servers.includes(s)),
        ...SERVER_LIST.filter(s => s !== 'tw' && s !== 'jp' && !servers.includes(s))
    ];
    for (const server of ordered) {
        if (await storeFor(server).songById(songId)) return server;
    }
    return servers[0];
}

export { router as songMetaRouter };
