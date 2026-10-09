import { hasServerInput, pickServer, Server } from '../types/Server';
import { getPlayerProfile } from '../../upstream/adapter';
import { drawPlayerProfile } from '../../render/view/player/playerProfile';
import { drawPlayerPackage } from '../../render/view/player/playerPackage';
import {
    inferServerFromPlayerId, isValidPlayerId,
    PlayerNotFoundError, PlayerUnavailableError
} from '../types/Player';
import { resolvePlayerTarget } from './playerBind';
import { loadAccountPackage } from './accountPackageData';

/**
 * 账号查询(/searchPlayer, tsugu 对应端点)的功能实现。
 *
 * 这是**用户动态数据**: 一次只查一个服, 服务器取 `displayedServerList` 的**首个**(单值即该服),
 * **不允许回退**。tsugu 文档把 playerId 声明为 number, 而本项目交友接口用纯数字字符串 ——
 * 这里两者都接受, 内部统一转成十进制字符串再拼 URL。
 *
 * 不传 playerId 时用**默认绑定**的账号（见 playerBind.ts）。
 *
 * 数据组合（上游档案 × 网页账号包）:
 *   上游有 + 有账号包 → 档案图(名片只出当前那一张) + 账号包图(完成状态/道具/理论队伍)
 *   上游有 + 无账号包 → 只出档案图
 *   上游没有 + 有账号包 → **只出账号包图**（页脚注明上游查不到）
 *   上游没有 + 无账号包 → 原有的错误提示（含绑定引导）
 * 账号包数据一律按网页的**公开开关**（隐藏即不显示, 绑定本人也一样）。
 */
export interface PlayerQuery {
    /** 玩家 ID, 数字与纯数字字符串都接受; 省略 = 用默认绑定 */
    playerId?: string | number;
    /** 绑定用户（QQ 号; 不传 playerId 时用它取默认绑定） */
    userId?: string;
    compress?: boolean;
    displayedServerList?: unknown;
}

export async function commandSearchPlayer(query: PlayerQuery): Promise<Array<Buffer | string>> {
    const compress = query.compress ?? false;

    // ---- 1. 解析目标: 显式 ID（按前缀推断服）或默认绑定 ----
    let playerId: string;
    let server: Server;
    const explicitId = query.playerId === undefined || query.playerId === null ? '' : String(query.playerId).trim();
    if (explicitId) {
        // 未显式指定服务器时, 按 ID 首位推断(2->tw / 3->en / 4->kr); JP 没有前缀规则, 必须显式传
        server = hasServerInput(query) ? pickServer(query) : (inferServerFromPlayerId(explicitId) ?? pickServer(query));
        if (!isValidPlayerId(server, explicitId)) {
            return [`错误: 该 ID 不符合 ${server} 服的账号格式`];
        }
        playerId = explicitId;
    } else {
        const target = await resolvePlayerTarget(query);
        if (target.status === 'error') return [target.message];
        playerId = target.playerId;
        server = target.server;
    }

    // ---- 2. 上游档案(没有/暂不可用都不致命: 账号包照出) ----
    let upstream: 'ok' | 'missing' | 'unavailable' = 'ok';
    let profile;
    try {
        profile = await getPlayerProfile(server, playerId);
    } catch (e) {
        if (e instanceof PlayerNotFoundError) upstream = 'missing';
        else if (e instanceof PlayerUnavailableError) upstream = 'unavailable';
        else throw e;
    }

    // ---- 3. 网页账号包(未对接/不可达/没有包 → undefined, 静默降级) ----
    const pkg = await loadAccountPackage(playerId, server).catch(() => undefined);

    // ---- 4. 组合输出 ----
    const out: Array<Buffer | string> = [];
    if (profile) {
        out.push(...await drawPlayerProfile(server, profile, compress));
    }
    if (pkg) {
        out.push(await drawPlayerPackage({
            playerId,
            server,
            title: pkg.account.label || pkg.account.playerName || profile?.name || playerId,
            upstream,
            songStatus: pkg.songStatus,
            bandItems: pkg.bandItems,
            bandDecks: pkg.bandDecks,
            bundle: pkg.bundle,
            tgwCardRank: pkg.account.tgwCardRank,
            accountUpdatedAt: pkg.account.updatedAt
        }, compress));
    }

    if (out.length) return out;

    // 两边都没有: 保持原有文案（含「去网页绑定/公开」的引导与临时故障提示）
    if (upstream === 'missing') return [`错误: ${new PlayerNotFoundError('site').message}`];
    return ['错误: 玩家数据源暂不可用，请稍后再试'];
}
