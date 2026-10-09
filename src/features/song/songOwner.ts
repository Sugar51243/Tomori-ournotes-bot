import { SERVER_LIST, Server } from '../types/Server';
import { storeFor } from '../../db/adapter';

/**
 * 该曲本体取哪个服的数据: 所选服优先, 其次港澳台 → 日服 → 其余。
 * (songMeta / eventRecommend 里各有一份同款实现, 新功能从这里共用一份。)
 */
export async function firstOwner(songId: number, server: Server): Promise<Server> {
    const ordered = [
        server,
        ...SERVER_LIST.filter(s => (s === 'tw' || s === 'jp') && s !== server),
        ...SERVER_LIST.filter(s => s !== 'tw' && s !== 'jp' && s !== server)
    ];
    for (const s of ordered) {
        if (await storeFor(s).songById(songId)) return s;
    }
    return server;
}
