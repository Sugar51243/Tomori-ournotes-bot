import { Server, withServer } from '../types/Server';
import { Stamp, stampTargetForScope } from '../types/Stamp';
import { refreshRegion, storeFor } from './region';
import { ensureFuzzyIndex } from '../fuzzyIndex';
import { match, FuzzySearchResult } from '../fuzzySearch';

/**
 * 贴纸检索。
 *
 * 关键词可以落在三个维度上(见 Stamp.fuzzyTarget):
 * - 贴纸名   -> 索引类型键 `stampId`
 * - 角色名   -> 索引类型键 `characterId`(复用角色索引)
 * - 团体名   -> 索引类型键 `bandId`(复用乐团索引)
 *
 * `scope` 决定只认哪一类名称:
 * - `all`:       三个维度都认
 * - `character`: 只认角色名
 * - `band`:      只认团体名
 */

export type StampScope = 'all' | 'character' | 'band';

/** 该服的全部贴纸(已 init) */
export async function allStamps(server: Server): Promise<Stamp[]> {
    await refreshRegion(server);
    const rows = await storeFor(server).stampList();
    const out: Stamp[] = [];
    for (const row of rows) {
        const stamp = withServer(new Stamp(row.id), server);
        await stamp.init();
        if (stamp.isExist) out.push(stamp);
    }
    return out;
}

/** 按模糊搜索结果筛选贴纸 */
export async function searchStamps(server: Server, matches: FuzzySearchResult, scope: StampScope = 'all'): Promise<Stamp[]> {
    await ensureFuzzyIndex(server);
    const stamps = await allStamps(server);

    // 纯数字关键词(如 "55")在 fuzzySearch 里落到 _number, 这里当作贴纸 ID 处理
    const numeric = ((matches['_number'] ?? []) as Array<string | number>)
        .map(v => Number(v))
        .filter(Number.isFinite);

    const hits = stamps.filter(stamp => {
        if (numeric.includes(stamp.stampId)) return true;
        return match(matches, stampTargetForScope(stamp, scope), []);
    });
    return hits;
}
