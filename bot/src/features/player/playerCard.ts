import { getPlayerProfile, imageBuffer, isAllowedExternalImage } from '../../upstream/adapter';
import { PlayerNotFoundError, PlayerUnavailableError } from '../types/Player';
import { serverProfile } from '../types/Server';
import { resolvePlayerTarget } from './playerBind';
import type { BindQuery } from './playerBind';

/**
 * 查名片（从「查玩家」拆出来的独立功能）。
 *
 * 名片 = 玩家在游戏里自己设计的 profile card —— 上游玩家档案接口只返回**当前使用的一套**
 * 的 1~3 页图（见 src/upstream/sources/haneoka.ts 的换算）。
 *
 * - 传 `page`：只出那一页的**原图**（不加框、不加文字，拿去直接用）;
 * - 不传：按页依次出全部原图。
 *
 * 数据源与查玩家同一套（上游回退链），与网页账号包无关。
 */

export interface PlayerCardQuery extends BindQuery {
    /** 页码（1 起）；不传 = 全部页 */
    page?: unknown;
}

export async function commandPlayerCard(query: PlayerCardQuery): Promise<Array<Buffer | string>> {
    const target = await resolvePlayerTarget(query);
    if (target.status === 'error') return [target.message];

    let profile;
    try {
        profile = await getPlayerProfile(target.server, target.playerId);
    } catch (e) {
        if (e instanceof PlayerNotFoundError || e instanceof PlayerUnavailableError) return [`错误: ${e.message}`];
        throw e;
    }

    // 与查玩家同一套外链白名单（防 SSRF），顺序即页码
    const urls = profile.profileCardUrls.filter(isAllowedExternalImage);
    const where = `${serverProfile(target.server).displayName} · ID ${target.playerId}`;
    if (!urls.length) return [`该账号没有可查询的名片（${where}）`];

    const pageRaw = query.page;
    let picks: Array<{ url: string; page: number }> = urls.map((url, i) => ({ url, page: i + 1 }));
    if (pageRaw !== undefined && pageRaw !== '') {
        const page = Number(pageRaw);
        if (!Number.isInteger(page) || page < 1 || page > urls.length) {
            return [`错误: 该账号有 ${urls.length} 张名片（页码 1~${urls.length}）`];
        }
        picks = [{ url: urls[page - 1], page }];
    }

    const out: Buffer[] = [];
    for (const { url, page } of picks) {
        const buf = await imageBuffer(url, `images/playercard/${target.server}/${target.playerId}_${page}.img`).catch(() => undefined);
        if (buf) out.push(buf);
    }
    if (!out.length) return [`错误: 名片图片暂时取不到（上游图床不可用），稍后重试（${where}）`];
    return out;
}
