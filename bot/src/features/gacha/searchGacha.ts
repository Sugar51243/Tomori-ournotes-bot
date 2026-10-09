import { isInteger, EntityInput } from '../../search/fuzzySearch';
import { Server, withServer } from '../types/Server';
import { Gacha } from '../types/Gacha';
import { textToFuzzyResult, searchGachas } from '../../search/search';
import { drawGachaDetail } from '../../render/view/gacha/gachaDetail';
import { drawGachaList } from '../../render/view/gacha/gachaList';

/**
 * 查卡池(单服回退)的功能实现。支持数字 ID 与模糊搜索:
 * 搜索按 **ID > 自信息 > 关联** 优先(卡片/乐团/角色/活动 -> 卡池), 多命中出卡池列表图。
 *
 * 查询输入按统一规则解析(见 routers/utils.pickEntityInput): `id` > `gachaId` > `text` > `fuzzySearchResult`;
 * 传一个字段即可 —— 纯数字按卡池 ID 直查, 其它文本走模糊搜索。
 */

export interface GachaQuery {
    input: EntityInput;
    compress?: boolean;
}

/** 查卡池入口: ID 直查 / 文本模糊(多命中列表图, 唯一命中详情图) */
export async function commandGacha(servers: Server[], query: GachaQuery): Promise<Array<Buffer | string>> {
    const { input, compress = false } = query;

    // 数字 ID -> 直查; 文本 -> 模糊搜索
    if (typeof input === 'string' && isInteger(input)) {
        return drawGachaById(servers, parseInt(input, 10), compress);
    }
    const hit = await findGachaMatches(servers, input);
    if ('error' in hit) return [hit.error];
    if (hit.gachas.length > 1) return drawGachaList(hit.server, hit.gachas, compress);
    return drawGachaDetail(hit.gachas[0], compress);
}

/** 按 ID 直查: 单服回退, 主体取回退链上第一个收录该卡池的区域 */
async function drawGachaById(servers: Server[], gachaId: number, compress: boolean): Promise<Array<Buffer | string>> {
    let gacha: Gacha | undefined;
    for (const server of servers) {
        const candidate = withServer(new Gacha(gachaId), server);
        await candidate.init();
        if (candidate.isExist) { gacha = candidate; break; }
    }
    if (!gacha) {
        return ['错误: 该卡池不存在'];
    }
    return drawGachaDetail(gacha, compress);
}

/** 文本/模糊结果在回退链上找卡池候选: 沿链依次查, 取第一个有结果的服 */
export async function findGachaMatches(
    servers: Server[],
    input: EntityInput
): Promise<{ server: Server; gachas: Gacha[] } | { error: string }> {
    if (typeof input !== 'string') {
        const server = servers[0];
        const gachas = await searchGachas(server, input);
        return gachas.length ? { server, gachas } : { error: '没有搜索到符合条件的卡池' };
    }
    let hasKeyword = false;
    for (const server of servers) {
        const matches = await textToFuzzyResult(server, input);
        if (Object.keys(matches).length === 0) continue;
        hasKeyword = true;
        const gachas = await searchGachas(server, matches);
        if (gachas.length === 0) continue;
        return { server, gachas };
    }
    return { error: hasKeyword ? '没有搜索到符合条件的卡池' : '错误: 没有有效的关键词' };
}
