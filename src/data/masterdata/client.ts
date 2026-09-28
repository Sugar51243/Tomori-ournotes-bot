import { config } from '../../config';
import { cachedJSON } from '../cachedFetch';
import { diskCache } from '../cache';
import { logger } from '../../logger';

export interface DataVersionInfo {
    dataVersion: string;
    resourceVersion: string;
}

export class MasterDataError extends Error { }

/**
 * 归一化 master 表:
 * - 数组 -> 直接使用
 * - { _allData: [...] } -> 取 _allData
 * - 键值对象 -> Object.values
 * - 行键剥离 _ 前缀
 */
export function normalizeTable(body: unknown): Record<string, unknown>[] {
    let rows: unknown[] = [];
    if (Array.isArray(body)) {
        rows = body;
    } else if (body && typeof body === 'object') {
        const obj = body as Record<string, unknown>;
        if (Array.isArray(obj._allData)) {
            rows = obj._allData;
        } else if (Array.isArray(obj.allData)) {
            rows = obj.allData;
        } else {
            const values = Object.values(obj);
            if (values.length === 1 && Array.isArray(values[0])) rows = values[0];
            else rows = values;
        }
    }
    return rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row as Record<string, unknown>;
        return Object.fromEntries(
            Object.entries(row as Record<string, unknown>).map(([k, v]) => [k.replace(/^_/, ''), v])
        );
    });
}

/**
 * masterdata 客户端:
 * - dataVersion 轮询(10min TTL, 允许陈旧回退)
 * - 表拉取, 按 dataVersion 分目录缓存, ETag 重验证, 404 视为空表
 * - 内存 store 按版本切换懒加载
 */
class MasterdataClient {
    private tables = new Map<string, Record<string, unknown>[]>();
    private currentVersion: string | undefined;
    private versionInfo: DataVersionInfo | undefined;

    async getDataVersion(): Promise<DataVersionInfo> {
        const res = await cachedJSON<Record<string, unknown>>(
            `${config.metaBase}/current_version.json`,
            { key: 'version/current_version.json', ttlS: config.versionTtlS, allowStale: true }
        );
        const regions = res.regions as Record<string, { version?: string; resource_version?: string }> | undefined;
        const region = regions?.['hk-tw-mo'];
        if (!region?.version) throw new MasterDataError('current_version.json missing hk-tw-mo region');
        return { dataVersion: region.version, resourceVersion: region.resource_version ?? '' };
    }

    private async ensureVersion(): Promise<DataVersionInfo> {
        if (!this.versionInfo) {
            this.versionInfo = await this.getDataVersion();
            this.currentVersion = this.versionInfo.dataVersion;
            // 启动时清理不属于当前版本的旧表目录(保留当前版本)
            await diskCache.pruneMasterdataVersions([this.currentVersion]);
        }
        return this.versionInfo;
    }

    /** 获取并缓存一张表; 404 -> 空表; 网络失败且有缓存 -> 陈旧回退 */
    async getTable<T = Record<string, unknown>>(name: string): Promise<T[]> {
        const { dataVersion } = await this.ensureVersion();
        const cacheKey = `masterdata/tables/${dataVersion}/${name}.json`;
        const cached = this.tables.get(cacheKey);
        if (cached) return cached as T[];

        const rows = await diskCache.singleFlight(cacheKey, async () => {
            try {
                const res = await cachedJSON<unknown>(
                    `${config.metaBase}/master/${name}.json?v=${encodeURIComponent(dataVersion)}`,
                    { key: cacheKey, ttlS: config.masterdataTtlS, allowStale: true, revalidate: true }
                );
                return normalizeTable(res);
            } catch (e) {
                const status = (e as { response?: { status?: number } })?.response?.status;
                if (status === 404) {
                    logger('masterdata', `table ${name} not found (404), treating as empty`);
                    await diskCache.write(cacheKey, Buffer.from('[]'), { etag: undefined });
                    return [];
                }
                throw e;
            }
        });
        const result = rows ?? [];
        this.tables.set(cacheKey, result);
        return result as T[];
    }

    /** dataVersion 变化时重置内存 store(由 /health 与门面调用) */
    async refreshIfVersionChanged(): Promise<boolean> {
        const info = await this.getDataVersion();
        if (info.dataVersion !== this.currentVersion) {
            logger('masterdata', `dataVersion changed: ${this.currentVersion} -> ${info.dataVersion}, resetting store`);
            this.tables.clear();
            this.versionInfo = info;
            this.currentVersion = info.dataVersion;
            await diskCache.pruneMasterdataVersions([info.dataVersion]);
            return true;
        }
        return false;
    }
}

export const masterdataClient = new MasterdataClient();
export const getDataVersion = () => masterdataClient.getDataVersion();
