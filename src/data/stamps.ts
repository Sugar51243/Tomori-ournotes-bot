import { Server, withServer } from '../types/Server';
import { Stamp, stampTargetForScope } from '../types/Stamp';
import { refreshRegion, storeFor } from './region';
import { ensureFuzzyIndex } from '../fuzzyIndex';
import { match, FuzzySearchResult } from '../fuzzySearch';
import { hasKeys, pickKeys, substringWords } from '../search';
import { bandsOfCharacters, characterIdsOfEvents, substringIds } from '../searchRelated';

/**
 * 贴纸检索。
 *
 * 搜索优先级 **ID > 自信息 > 关联**:
 * - 自信息: 贴纸名 -> 索引类型键 `stampId`(数字关键词按贴纸 ID 处理)
 * - 关联:   角色名 -> `characterId`、团体名 -> `bandId`、活动 -> 该活动的加成角色
 *           (该角色所属团体的贴纸; `scope=band` 时只认团体维度)
 *
 * `scope` 决定只认哪一类名称:
 * - `all`:       各维度都认
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

    // 自信息: 贴纸名(stampId); 关联: 角色/乐团(贴纸自带) + 活动(-> 活动加成角色)
    let fuzzy: FuzzySearchResult;
    if (hasKeys(matches, ['stampId'])) {
        fuzzy = pickKeys(matches, ['stampId', '_number', '_all']);
    } else {
        const words = substringWords(matches);
        const bucket = pickKeys(matches, ['_all']);
        const nums = (key: string): number[] => ((matches[key] ?? []) as Array<string | number>).map(Number).filter(Number.isFinite);
        const merge = (a: number[], b: number[]): number[] => [...new Set([...a, ...b])];
        const bandIds = merge(nums('bandId'), substringIds(server, 'bandId', words));
        const charIds = merge(nums('characterId'), substringIds(server, 'characterId', words));
        if (bandIds.length) bucket['bandId'] = bandIds;
        if (charIds.length) bucket['characterId'] = charIds;
        const byEvents = await characterIdsOfEvents(server, merge(nums('eventId'), substringIds(server, 'eventId', words)));
        if (byEvents.length) {
            const [key, related] = scope === 'band'
                ? ['bandId', await bandsOfCharacters(server, byEvents)]
                : ['characterId', byEvents];
            if (related.length) bucket[key] = merge((bucket[key] ?? []) as number[], related);
        }
        fuzzy = bucket;
    }
    // 空匹配 = 不过滤(全部贴纸)
    if (Object.keys(matches).length > 0 && Object.keys(fuzzy).length === 0) return [];

    const hits = stamps.filter(stamp => {
        if (numeric.includes(stamp.stampId)) return true;
        return match(fuzzy, stampTargetForScope(stamp, scope), []);
    });
    return hits;
}
