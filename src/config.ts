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
    /** rankd 游戏数据(公告/排行): 公开只读, 无鉴权 */
    gameApiBase: envStr('GAME_API_BASE', 'https://api.bdon.moe').replace(/\/+$/, ''),
    /** moenotes 站点: 玩家档案公开接口与国旗图标 */
    moenotesSiteBase: envStr('MOENOTES_SITE_BASE', 'https://bdon.moe').replace(/\/+$/, ''),
    /** 可选的 moenotes-api 自建网关(能查任意玩家); 未配置时玩家查询回退站点公开接口 */
    moenotesApiBase: envStr('MOENOTES_API_BASE', '').replace(/\/+$/, ''),
    moenotesApiKey: envStr('MOENOTES_API_KEY', ''),
    cacheDir: path.resolve(envStr('CACHE_DIR', './cache')),
    /** 缺省区域; 请求未指定服务器时使用 */
    defaultServer: envStr('DEFAULT_SERVER', 'tw'),
    defaultLocale: envStr('DEFAULT_LOCALE', 'zh-Hans'),
    localeFallbacks: envStr('LOCALE_FALLBACKS', 'zh-Hans,zh-CN,ja,en')
        .split(',').map(s => s.trim()).filter(Boolean),
    masterdataTtlS: envInt('MASTERDATA_TTL_S', 3600),
    versionTtlS: envInt('VERSION_TTL_S', 600),
    chartManifestTtlS: envInt('CHART_MANIFEST_TTL_S', 604800),
    chartAssetTtlS: envInt('CHART_ASSET_TTL_S', 2592000),
    imageTtlS: envInt('IMAGE_TTL_S', 604800),
    /** 公告列表缓存(上游 Cache-Control: max-age=300) */
    announcementTtlS: envInt('ANNOUNCEMENT_TTL_S', 300),
    /** 公告轮询间隔(SSE 推送的延迟来源) */
    announcementPollS: envInt('ANNOUNCEMENT_POLL_S', 300),
    /** 歌曲排行缓存 */
    rankingTtlS: envInt('RANKING_TTL_S', 300),
    /** 玩家档案缓存 */
    playerTtlS: envInt('PLAYER_TTL_S', 300),
    /** SSE 心跳间隔(注释行保活) */
    sseHeartbeatS: envInt('SSE_HEARTBEAT_S', 25),
    /** 歌表分页: 每张图放多少首歌(每首歌占 1 个区块头 + N 个服务器行) */
    songsPerPage: envInt('SONGS_PER_PAGE', 20),
    /** 贴纸列表分页: 每张图放多少张(5 列栅格, 默认 30 = 6 行) */
    stampsPerPage: envInt('STAMPS_PER_PAGE', 30),
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

export const LANE_COUNT = 24;
