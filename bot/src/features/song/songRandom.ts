import { EntityInput } from '../../search/fuzzySearch';
import { Server } from '../types/Server';
import { searchSongs, textToFuzzyResult } from '../../search/search';
import { drawSongRandom } from '../../render/view/song/songRandom';

/**
 * 随机歌曲(多服)的功能实现。
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput): `id` > `songId` > `text` > `fuzzySearchResult`;
 * 一个都不传时从全部歌曲里随机。文本命中多首时在命中集合里随机。
 */

export interface SongRandomQuery {
    /** 不传 = 从全部歌曲随机 */
    input?: EntityInput;
    compress?: boolean;
}

/** 随机歌曲入口: 不传输入全曲池随机, 传文本在命中集合里随机 */
export async function commandSongRandom(servers: Server[], query: SongRandomQuery): Promise<Array<Buffer | string>> {
    const server = servers[0];
    let candidates;
    if (query.input === undefined) {
        candidates = await searchSongs(server, {});
    } else if (typeof query.input === 'string') {
        candidates = await searchSongs(server, await textToFuzzyResult(server, query.input));
    } else {
        candidates = await searchSongs(server, query.input);
    }
    return drawSongRandom(candidates, servers, query.compress ?? false);
}
