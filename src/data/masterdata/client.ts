import { config } from '../../config';
import { cachedJSON } from '../cachedFetch';
import { diskCache } from '../cache';
import { logger } from '../../logger';
import { Server, serverProfile } from '../../types/Server';

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
 * dataVersion 用作目录名时必须净化 ——
 * jp 的版本形如 `1.0.0.300/9c69e777...`(资源版本 + 哈希, 中间是斜杠),
 * 直接用会多出一层目录, 并使 pruneMasterdataVersions 的「按版本删目录」判断错位。
 */
export function versionToken(dataVersion: string): string {
    return dataVersion.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---- 版本清单: 一份文档含全部区域, 全局只拉一次 ----

export interface VersionManifest {
    /** current_version.json 里的 regions 原样保留(键为上游键名, tw 的键是 hk-tw-mo) */
    regions: Record<string, DataVersionInfo>;
    fetchedAt: number;
}

let manifest: VersionManifest | undefined;
let manifestInflight: Promise<VersionManifest> | undefined;

/**
 * 读取 current_version.json。全文只请求一次并进程内缓存(VERSION_TTL_S),
 * 与后续访问了几个区域无关 —— 各区域只是从中取自己那一份。
 */
export async function getVersionManifest(force = false): Promise<VersionManifest> {
    if (!force && manifest && Date.now() - manifest.fetchedAt < config.versionTtlS * 1000) {
        return manifest;
    }
    if (manifestInflight) return manifestInflight;

    manifestInflight = (async () => {
        const res = await cachedJSON<{ regions?: Record<string, { version?: string; resource_version?: string }> }>(
            `${config.metaBase}/current_version.json`,
            { key: 'version/current_version.json', ttlS: config.versionTtlS, allowStale: true }
        );
        const regions: Record<string, DataVersionInfo> = {};
        for (const [key, region] of Object.entries(res.regions ?? {})) {
            if (!region?.version) continue;
            regions[key] = { dataVersion: region.version, resourceVersion: region.resource_version ?? '' };
        }
        if (Object.keys(regions).length === 0) {
            throw new MasterDataError('current_version.json contains no usable regions');
        }
        manifest = { regions, fetchedAt: Date.now() };
        return manifest;
    })().finally(() => { manifestInflight = undefined; });

    return manifestInflight;
}

/** 同步读已加载的清单(未加载返回 undefined); 供 pickServers 之类的判断使用 */
export function cachedVersionManifest(): VersionManifest | undefined {
    return manifest;
}

/**
 * masterdata 客户端(每个区域一个实例):
 * - 表拉取, 按「区域 + dataVersion」分目录缓存, ETag 重验证, 404 视为空表
 * - 内存表引用按实例隔离, 天然按区域分片
 */
export class MasterdataClient {
    readonly server: Server;
    private tables = new Map<string, Record<string, unknown>[]>();
    private currentVersion: string | undefined;

    constructor(server: Server) {
        this.server = server;
    }

    /** 本区域的版本; 清单里没有该区域时抛错 */
    async getDataVersion(): Promise<DataVersionInfo> {
        const profile = serverProfile(this.server);
        const info = (await getVersionManifest()).regions[profile.masterdataKey];
        if (!info?.dataVersion) {
            throw new MasterDataError(`current_version.json missing region ${profile.masterdataKey}`);
        }
        return info;
    }

    private async ensureVersion(): Promise<string> {
        if (!this.currentVersion) {
            this.currentVersion = (await this.getDataVersion()).dataVersion;
            // 首次拉起时清理本区域不属于当前版本的旧表目录
            await diskCache.pruneMasterdataVersions(this.server, [versionToken(this.currentVersion)]);
        }
        return this.currentVersion;
    }

    /** 获取并缓存一张表; 404 -> 空表; 网络失败且有缓存 -> 陈旧回退 */
    async getTable<T = Record<string, unknown>>(name: string): Promise<T[]> {
        const dataVersion = await this.ensureVersion();
        const cacheKey = `masterdata/tables/${this.server}/${versionToken(dataVersion)}/${name}.json`;
        const cached = this.tables.get(cacheKey);
        if (cached) return cached as T[];

        const rows = await diskCache.singleFlight(cacheKey, async () => {
            try {
                const res = await cachedJSON<unknown>(
                    `${config.metaBase}/${serverProfile(this.server).masterPath}/master/${name}.json?v=${encodeURIComponent(dataVersion)}`,
                    { key: cacheKey, ttlS: config.masterdataTtlS, allowStale: true, revalidate: true }
                );
                return normalizeTable(res);
            } catch (e) {
                const status = (e as { response?: { status?: number } })?.response?.status;
                if (status === 404) {
                    logger('masterdata', `[${this.server}] table ${name} not found (404), treating as empty`);
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

    /** 版本变化时重置本区域的内存表 */
    async refreshIfVersionChanged(): Promise<boolean> {
        const info = await this.getDataVersion();
        if (info.dataVersion !== this.currentVersion) {
            logger('masterdata', `[${this.server}] dataVersion changed: ${this.currentVersion} -> ${info.dataVersion}, resetting store`);
            this.tables.clear();
            this.currentVersion = info.dataVersion;
            await diskCache.pruneMasterdataVersions(this.server, [versionToken(info.dataVersion)]);
            return true;
        }
        return false;
    }
}

const clients = new Map<Server, MasterdataClient>();

/** 每个区域一个客户端实例(懒创建) */
export function clientFor(server: Server): MasterdataClient {
    let client = clients.get(server);
    if (!client) {
        client = new MasterdataClient(server);
        clients.set(server, client);
    }
    return client;
}
