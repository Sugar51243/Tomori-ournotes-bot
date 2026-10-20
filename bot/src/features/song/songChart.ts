import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { Server } from '../types/Server';
import { drawSongChart } from '../../render/view/song/songChart';
import { drawSongList } from '../../render/view/song/songList';
import { firstServerHavingSong } from '../../db/adapter';
import { findSongMatches } from './searchSong';

/**
 * 谱面图(单服回退)的功能实现。
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`,
 * 传一个字段即可 —— 数字/纯数字字符串按 ID 直查, 其它文本走模糊搜索(唯一命中出谱面图, 多命中出歌曲列表图)。
 */

export interface SongChartQuery {
    songId: number;
    difficultyId: number;
    compress: boolean;
    mirror: boolean;
    noteSpeed: number;
}

/** 单服回退: 沿回退链取第一个收录该曲的服出谱面图 */
export async function drawChartForId(servers: Server[], query: SongChartQuery): Promise<Array<Buffer | string>> {
    const server = await firstServerHavingSong(query.songId, servers);
    if (!server) return ['错误: 歌曲不存在'];
    return drawSongChart(server, query.songId, query.difficultyId, query.compress, query.mirror, query.noteSpeed);
}

/** 端点入口: 数字直查; 文本走模糊搜索(多命中出歌曲列表图) */
export async function commandSongChart(
    servers: Server[],
    input: EntityInput,
    options: { difficultyId: number; compress?: boolean; mirror: boolean; noteSpeed: number }
): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        return drawChartForId(servers, {
            songId: parseInt(input, 10),
            difficultyId: options.difficultyId,
            compress: options.compress ?? false,
            mirror: options.mirror,
            noteSpeed: options.noteSpeed
        });
    }
    // 文字搜索: 沿回退链找候选(ID > 自信息 > 关联由 search 层保证)
    const hit = await findSongMatches(servers, input);
    if ('error' in hit) return [hit.error];
    // 多命中 -> 歌曲列表图(compress 原样透传); 唯一命中 -> 该曲谱面图
    if (hit.songs.length > 1) return drawSongList(hit.server, hit.songs, options.compress ?? false);
    return drawChartForId(servers, {
        songId: hit.songs[0].songId,
        difficultyId: options.difficultyId,
        compress: options.compress ?? false,
        mirror: options.mirror,
        noteSpeed: options.noteSpeed
    });
}
