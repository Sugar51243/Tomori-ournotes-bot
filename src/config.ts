import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

function envStr(name: string, fallback: string): string {
    return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number): number {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return v.trim().toLowerCase() === 'true';
}

function envJson<T>(name: string, fallback: T): T {
    try {
        return JSON.parse(process.env[name] || '') as T;
    } catch {
        return fallback;
    }
}

const port = envInt('PORT', 3000);
if (!Number.isFinite(port)) {
    console.error('[config] PORT is not a number');
    process.exit(1);
}

export const config = {
    port,
    metaBase: envStr('META_BASE', 'https://metadata.bdon.moe').replace(/\/+$/, ''),
    assetBase: envStr('ASSET_BASE', 'https://assets.bdon.moe').replace(/\/+$/, ''),
    cacheDir: path.resolve(envStr('CACHE_DIR', './cache')),
    defaultLocale: envStr('DEFAULT_LOCALE', 'zh-Hans'),
    localeFallbacks: envStr('LOCALE_FALLBACKS', 'zh-Hans,zh-CN,ja,en')
        .split(',').map(s => s.trim()).filter(Boolean),
    masterdataTtlS: envInt('MASTERDATA_TTL_S', 3600),
    versionTtlS: envInt('VERSION_TTL_S', 600),
    chartManifestTtlS: envInt('CHART_MANIFEST_TTL_S', 604800),
    chartAssetTtlS: envInt('CHART_ASSET_TTL_S', 2592000),
    imageTtlS: envInt('IMAGE_TTL_S', 604800),
    maxConcurrencyPerHost: envInt('MAX_CONCURRENCY_PER_HOST', 4),
    httpTimeoutMs: envInt('HTTP_TIMEOUT_MS', 20000),
    logLevel: envStr('LOG_LEVEL', 'info'),
    enableDb: envBool('ENABLE_DB', false),
    /** 社区功能(交友/车站)的 MongoDB; 未配置 URI 时这些接口按"服务器未启用数据库"处理 */
    mongoUri: envStr('MONGODB_URI', ''),
    mongoDb: envStr('MONGODB_DB', 'tomori'),
    dbConnectTimeoutMs: envInt('DB_CONNECT_TIMEOUT_MS', 3000),
    /** 车站房间有效期(秒): 默认同 tsugu 的 150 秒 */
    stationTtlS: envInt('STATION_TTL_S', 150),
    gachaDefaultRates: envJson<Record<string, number>>('GACHA_DEFAULT_RATES', { '2': 88.5, '3': 8.5, '4': 3.0 }),
    userAgent: `tomori/0.1 (Node ${process.version})`
};

export const REGION = 'hk-tw-mo';
export const LANE_COUNT = 24;
