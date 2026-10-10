import { config } from '../config';
import { ttl } from '../config/ttl';
import { cachedFetch } from '../upstream/cachedFetch';
import { logger } from '../logger';
import type { Server } from '../features/types/Server';
import { BUNDLE_FORMAT } from './types';
import type { MasterBundle } from './types';

/**
 * 组卡查表用的 master bundle —— 拉**网页平台**的公开端点
 *（`/api/game-accounts/master-bundle`，与网页组卡器同一份，保证「与 web 同逻辑」的输入一致）。
 *
 * 走 bot 的磁盘缓存: 该端点带 ETag, 版本没变就是一次 304 空响应; 网络故障时允许回退陈旧副本
 *（组卡是静态数据, 旧一版照样能算）。拿不到就返回 undefined, 由调用方按领域错误处理。
 */
export async function getMasterBundle(server: Server): Promise<MasterBundle | undefined> {
    const options = {
        key: `webplatform/master-bundle/${server}.json`,
        ttlS: ttl.masterBundleTtlS,
        allowStale: true,
        revalidate: true,
        /**
         * **每次都要走条件请求**。
         *
         * 只给 `revalidate` 是不够的：cachedFetch 会先看 TTL，24 小时内的副本直接当命中返回，
         * 连 If-None-Match 都不发 —— 于是游戏版本变了（新卡、活动加成条件行）这份查表数据
         * 最多会旧一天，而且**看不出任何异样**（照旧能算出结果，只是算错）。
         * cachedFetch 里那句「变更检测必须用它」说的就是这件事。
         * 版本没变时它就是一次 304 空响应，几乎不花流量。
         */
        forceRefresh: true
    } as const;
    const fetchBundle = (fmt: number | null) =>
        cachedFetch(
            `${config.webPlatformBase}/api/game-accounts/master-bundle?server=${server}${fmt === null ? '' : `&fmt=${fmt}`}`,
            options
        ).catch(() => undefined);
    // 带上本端认识的 fmt 请求; 网页平台还是旧版时会 400(只认它自己的版本) —— 退回不带 fmt 再试,
    // v3→v4 是尾部追加的可读兼容改动, 旧版数据照样能算(见 types.ts liveSkillRatios 的说明)。
    let res = await fetchBundle(BUNDLE_FORMAT);
    try {
        const parsed = res ? (JSON.parse(res.data.toString('utf8')) as { ok?: boolean; data?: MasterBundle }) : undefined;
        if (!parsed?.ok || !parsed.data || parsed.data.fmt === undefined || parsed.data.fmt > BUNDLE_FORMAT) {
            res = (await fetchBundle(null)) ?? res;
        }
    } catch {
        res = (await fetchBundle(null)) ?? res;
    }
    if (!res) return undefined;
    try {
        const parsed = JSON.parse(res.data.toString('utf8')) as { ok?: boolean; data?: MasterBundle };
        const bundle = parsed.data;
        if (!parsed.ok || !bundle || typeof bundle !== 'object' || !Array.isArray(bundle.mcards) || !Array.isArray(bundle.chars)) {
            logger('deck', `master bundle 形状不符合预期(server=${server})`);
            return undefined;
        }
        // 认 ≤ 本端的版本: 旧版是尾部缺字段的兼容形状(live 技能数据缺席时基准回退 60%),
        // 比本端**新**的版本才拒绝(可能缺我们读不到的字段, 硬读会错位)。
        if (bundle.fmt > BUNDLE_FORMAT) {
            logger('deck', `master bundle 版本过新(server=${server}): 本端 v${BUNDLE_FORMAT}, 拿到 v${bundle.fmt}`);
            return undefined;
        }
        if (bundle.fmt < BUNDLE_FORMAT) {
            logger('deck', `master bundle 为旧版(server=${server}): v${bundle.fmt} < v${BUNDLE_FORMAT}, 按兼容形状使用(live 技能基准回退)`);
        }
        return bundle;
    } catch (e) {
        logger('deck', `master bundle 解析失败(server=${server}): ${e instanceof Error ? e.message : e}`);
        return undefined;
    }
}
