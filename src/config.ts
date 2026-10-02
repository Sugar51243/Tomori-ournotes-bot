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

function envFloat(name: string, fallback: number): number {
    const v = parseFloat(process.env[name] || '');
    return Number.isFinite(v) ? v : fallback;
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
    /** 榜线(各档分数)记录间隔(秒): 每小时落一个采样点 */
    cutoffRecordIntervalS: envInt('CUTOFF_RECORD_INTERVAL_S', 3600),
    /**
     * 榜线采样点的聚合粒度(秒)。同一桶内的多次采样互相覆盖, 默认 3600(整点桶)。
     * 调小只对自检有意义(几秒一个桶就能在假上游上攒出多点的折线), 生产保持默认。
     */
    cutoffBucketS: envInt('CUTOFF_BUCKET_S', 3600),
    /** 谱面效率数据(music-data.json, 站点「歌曲meta」同源); 随游戏版本更新 */
    musicDataUrl: envStr('MUSIC_DATA_URL', 'https://storage.bdon.moe/moenotes/music-data/music-data.json').replace(/\/+$/, ''),
    musicDataTtlS: envInt('MUSIC_DATA_TTL_S', 86400),
    /** 玩家档案缓存 */
    playerTtlS: envInt('PLAYER_TTL_S', 300),
    /** SSE 心跳间隔(注释行保活) */
    sseHeartbeatS: envInt('SSE_HEARTBEAT_S', 25),
    /** 贴纸列表分页: 每张图放多少张(5 列栅格, 默认 30 = 6 行) */
    stampsPerPage: envInt('STAMPS_PER_PAGE', 30),
    /** 交友列表分页: 每张图放多少人 */
    friendsPerPage: envInt('FRIENDS_PER_PAGE', 30),
    /** 谱面预览的默认流速(范围固定 1.00~12.00); 请求未指定 noteSpeed/speed 时使用 */
    noteSpeedDefault: envFloat('NOTE_SPEED_DEFAULT', 7.5),
    /** 渲染结果缓存上限(MB): 出图开销主要在 PNG 编码, 相同查询直接回缓存 */
    renderCacheBytes: envInt('RENDER_CACHE_MB', 128) * 1024 * 1024,
    /** 已解码图片的缓存上限(MB): 避免每次出图都为上百张图走一遍磁盘缓存并重新解码 */
    imageCacheBytes: envInt('IMAGE_CACHE_MB', 64) * 1024 * 1024,
    maxConcurrencyPerHost: envInt('MAX_CONCURRENCY_PER_HOST', 4),
    /** 同一主机的两次上游请求最小间隔(毫秒, 礼貌限流) */
    httpMinIntervalMs: envInt('HTTP_MIN_INTERVAL_MS', 100),
    /** 网络错误/5xx 的重试次数(4xx 不重试) */
    httpRetries: envInt('HTTP_RETRIES', 3),
    /** 重试退避基数(毫秒): 第 n 次重试等待 基数 × 3^(n-1) */
    httpRetryBaseMs: envInt('HTTP_RETRY_BASE_MS', 1000),
    httpTimeoutMs: envInt('HTTP_TIMEOUT_MS', 20000),
    logLevel: envStr('LOG_LEVEL', 'info'),
    enableDb: envBool('ENABLE_DB', false),
    /** 社区功能(交友/车站)的 MongoDB; 未配置 URI 时这些接口按"服务器未启用数据库"处理 */
    mongoUri: envStr('MONGODB_URI', ''),
    mongoDb: envStr('MONGODB_DB', 'tomori'),
    dbConnectTimeoutMs: envInt('DB_CONNECT_TIMEOUT_MS', 3000),
    /** 车站房间有效期(秒): 默认同 tsugu 的 150 秒 */
    stationTtlS: envInt('STATION_TTL_S', 150),
    /**
     * 用户关键词的内存快照存活时间(秒)。关键词存在 MongoDB 里, 搜索与出图都要用,
     * 每次请求都查库不划算; 上传/删除会主动强制刷新, 这里的 TTL 只兜底多进程/多实例场景。
     */
    keywordCacheTtlS: envInt('KEYWORD_CACHE_TTL_S', 60),
    /** 单条用户关键词的长度上限(字) */
    maxKeywordLength: envInt('MAX_KEYWORD_LENGTH', 32),
    /** 单个实体可挂的用户关键词数量上限 */
    maxKeywordsPerEntity: envInt('MAX_KEYWORDS_PER_ENTITY', 20),
    gachaDefaultRates: envJson<Record<string, number>>('GACHA_DEFAULT_RATES', { '2': 88.5, '3': 8.5, '4': 3.0 }),
    /** 上游请求的 User-Agent; 留空则用内置默认(带运行时 Node 版本) */
    userAgent: envStr('USER_AGENT', `tomori/0.1 (Node ${process.version})`)
};
