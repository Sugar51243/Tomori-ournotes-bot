import { hasServerInput, pickServer, Server } from '../types/Server';
import { getPlayerProfile } from '../../upstream/adapter';
import { drawPlayerProfile } from '../../render/view/player/playerProfile';
import {
    inferServerFromPlayerId, isValidPlayerId,
    PlayerNotFoundError, PlayerUnavailableError
} from '../types/Player';

/**
 * 账号查询(/searchPlayer, tsugu 对应端点)的功能实现。
 *
 * 这是**用户动态数据**: 一次只查一个服, 服务器取 `displayedServerList` 的**首个**(单值即该服),
 * **不允许回退**。tsugu 文档把 playerId 声明为 number, 而本项目交友接口用纯数字字符串 ——
 * 这里两者都接受, 内部统一转成十进制字符串再拼 URL。
 */
export interface PlayerQuery {
    /** 玩家 ID, 数字与纯数字字符串都接受 */
    playerId: string | number;
    compress?: boolean;
    displayedServerList?: unknown;
}

/**
 * 账号查询入口: 未指定服务器时按 ID 前缀推断(2→tw/3→en/4→kr), 再拉档案出图。
 * 玩家不存在/上游不可用分别转成对应的错误提示。
 */
export async function commandSearchPlayer(query: PlayerQuery): Promise<Array<Buffer | string>> {
    const playerId = String(query.playerId);
    const compress = query.compress ?? false;
    // 未显式指定服务器时, 按 ID 首位推断(2->tw / 3->en / 4->kr); JP 没有前缀规则, 必须显式传
    const explicit = hasServerInput(query);
    const server: Server = explicit ? pickServer(query) : (inferServerFromPlayerId(playerId) ?? pickServer(query));

    if (!isValidPlayerId(server, playerId)) {
        return [`错误: 该 ID 不符合 ${server} 服的账号格式`];
    }

    try {
        const profile = await getPlayerProfile(server, playerId);
        return drawPlayerProfile(server, profile, compress);
    } catch (e) {
        if (e instanceof PlayerNotFoundError) return [`错误: ${e.message}`];
        if (e instanceof PlayerUnavailableError) return [`错误: ${e.message}`];
        throw e;
    }
}
