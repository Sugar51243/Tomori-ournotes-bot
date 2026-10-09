import { config } from '../config';
import { ttl } from '../config/ttl';
import { cachedFetch } from '../upstream/cachedFetch';
import { logger } from '../logger';
import type { Server } from '../features/types/Server';
import type { MasterBundle } from './types';

/**
 * 组卡查表用的 master bundle —— 拉**网页平台**的公开端点
 *（`/api/game-accounts/master-bundle`，与网页组卡器同一份，保证「与 web 同逻辑」的输入一致）。
 *
 * 走 bot 的磁盘缓存: 该端点带 ETag, 版本没变就是一次 304 空响应; 网络故障时允许回退陈旧副本
 *（组卡是静态数据, 旧一版照样能算）。拿不到就返回 undefined, 由调用方按领域错误处理。
 */
export async function getMasterBundle(server: Server): Promise<MasterBundle | undefined> {
    const url = `${config.webPlatformBase}/api/game-accounts/master-bundle?server=${server}&fmt=3`;
    const res = await cachedFetch(url, {
        key: `webplatform/master-bundle/${server}.json`,
        ttlS: ttl.masterBundleTtlS,
        allowStale: true,
        revalidate: true
    }).catch(() => undefined);
    if (!res) return undefined;
    try {
        const parsed = JSON.parse(res.data.toString('utf8')) as { ok?: boolean; data?: MasterBundle };
        const bundle = parsed.data;
        if (!parsed.ok || !bundle || typeof bundle !== 'object' || !Array.isArray(bundle.mcards) || !Array.isArray(bundle.chars)) {
            logger('deck', `master bundle 形状不符合预期(server=${server})`);
            return undefined;
        }
        return bundle;
    } catch (e) {
        logger('deck', `master bundle 解析失败(server=${server}): ${e instanceof Error ? e.message : e}`);
        return undefined;
    }
}
