import { Song } from '../types/Song';
import { drawSongDetail } from './songDetail';

/** 从候选集随机选一首 -> 详情图 */
export async function drawSongRandom(candidates: Song[], compress: boolean): Promise<Array<Buffer | string>> {
    if (candidates.length === 0) {
        return ['没有搜索到符合条件的歌曲'];
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    return drawSongDetail(picked, compress);
}
