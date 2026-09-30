import { Song } from '../types/Song';
import { Server } from '../types/Server';
import { songServerRows } from '../data/serverInfo';
import { drawSongDetail } from './songDetail';

/**
 * 从候选集随机选一首 -> 详情图。
 * 随机发生在这里(而不是调用方), 各服差异表必须对应**被抽中的那一首**。
 */
export async function drawSongRandom(candidates: Song[], servers: Server[], compress: boolean): Promise<Array<Buffer | string>> {
    if (candidates.length === 0) {
        return ['没有搜索到符合条件的歌曲'];
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    const rows = await songServerRows(picked.songId, servers);
    return drawSongDetail(picked, rows, compress);
}
