import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { Server, withServer } from '../types/Server';
import { Song } from '../types/Song';
import { getMusicRanking } from '../../upstream/adapter';
import { drawSongRanking } from '../../render/view/song/songRanking';
import { drawSongList } from '../../render/view/song/songList';
import { findSongMatches } from './searchSong';

/**
 * 歌曲排行榜(前十用户与出分)的功能实现。
 *
 * 这是**用户动态数据**, 与「同一实体多服对比」的静态信息不同 —— 一次只查一个服,
 * 服务器取 `displayedServerList` 的**首个**(单值即该服), **不允许回退**。
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 传文本时只在该服的索引里搜索(数据本身只属于这一个服, 不跨服回退)。
 */

export interface SongRankingQuery {
    songId: number;
    compress?: boolean;
}

/** 歌曲排行榜入口: 单服, 拉上游前十用户出分图 */
export async function commandSongRanking(server: Server, query: SongRankingQuery): Promise<Array<Buffer | string>> {
    const { songId, compress = false } = query;
    const song = withServer(new Song(songId), server);
    await song.init();
    if (!song.isExist) {
        return ['错误: 歌曲不存在'];
    }
    const ranking = await getMusicRanking(server, songId, 10);
    return drawSongRanking(server, songId, song.musicTitle, ranking, compress);
}

/** 端点入口: 数字直查; 文本在该服索引里搜索(唯一命中出排行, 多命中出列表图) */
export async function commandSongRankingFromInput(server: Server, input: EntityInput, compress?: boolean): Promise<Array<Buffer | string>> {
    if (typeof input === 'string' && isInteger(input)) {
        return commandSongRanking(server, { songId: parseInt(input, 10), compress });
    }
    const hit = await findSongMatches([server], input);
    if ('error' in hit) return [hit.error];
    if (hit.songs.length > 1) return drawSongList(server, hit.songs, compress ?? false);
    return commandSongRanking(server, { songId: hit.songs[0].songId, compress });
}
