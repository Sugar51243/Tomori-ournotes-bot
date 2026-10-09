import * as dotenv from 'dotenv';
import * as path from 'path';
import { DATA_SOURCES, DEFAULT_DATA_SOURCE, FALLBACK_DATA_SOURCE, SourceRole } from './sources';

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

// ---- 数据源链: DATA_SOURCE → BACKUP_SOURCE → bdon.moe(恒定兜底), 去重; 具体档案见 ./sources.ts ----
const dataSource = envStr('DATA_SOURCE', DEFAULT_DATA_SOURCE);
const backupSource = envStr('BACKUP_SOURCE', '');

function resolveSourceChain(names: readonly string[]): string[] {
    const out: string[] = [];
    for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;                                     // 空 = 未配置, 静默跳过
        if (!DATA_SOURCES[name]) {
            // 这里不能用 logger(logger 依赖 config, 会成环)
            console.warn(`[config] 未知的上游数据源 "${name}", 已跳过`);
            continue;
        }
        if (!out.includes(name)) out.push(name);
    }
    if (!out.includes(FALLBACK_DATA_SOURCE)) out.push(FALLBACK_DATA_SOURCE);
    return out;
}

const sourceChain = resolveSourceChain([dataSource, backupSource]);
// 规范化 URL 恒用 bdon 布局 —— 客户端照旧拼 URL, DATA_SOURCE/BACKUP_SOURCE 只决定尝试顺序
const canonical = DATA_SOURCES[FALLBACK_DATA_SOURCE];
const trimSlash = (s: string): string => s.replace(/\/+$/, '');

// ---- 玩家查询优先源(PLAYER_SOURCE, 可选) ----
// 玩家查询对应「site」角色: 把该源挪到 site 角色链首(其余顺序不变)。例: haneoka.org 能查任意日服玩家,
// 而站点公开接口只收录已绑定账号 —— 置顶它可以省掉一次注定 404 的请求。留空 = 完全按通用链顺序。
const playerSource = envStr('PLAYER_SOURCE', '');
if (playerSource && !DATA_SOURCES[playerSource]) {
    console.warn(`[config] 未知的玩家查询源 "${playerSource}", 已忽略`);
} else if (playerSource && !DATA_SOURCES[playerSource].roles.includes('site')) {
    console.warn(`[config] 玩家查询源 "${playerSource}" 不承担 site(玩家/站点)角色, 该设置不会生效`);
}
const sourceChainByRole: Partial<Record<SourceRole, string[]>> = playerSource && DATA_SOURCES[playerSource]
    ? { site: [playerSource, ...sourceChain.filter(n => n !== playerSource)] }
    : {};

// ---- 默认服务器回退链(原始字符串; 归一/去重/补全见 features/types/Server.ts serverChainList) ----
const serverChain = envStr('DEFAULT_SERVER_CHAIN', 'tw,jp,kr,en')
    .split(',').map(s => s.trim()).filter(Boolean);

/** 全局配置对象: 进程启动时从 .env 一次性读取(运行期不变), 各处经 import { config } 访问 */
export const config = {
    port,
    /** HTTP 监听地址: 127.0.0.1 仅本机可访问; 0.0.0.0 对外公开(本服务无鉴权, 暴露前请自行加防护) */
    location: envStr('LOCATION', '127.0.0.1'),
    /** 主源模式名(最先尝试, 见 ./sources.ts); 未知名告警跳过 */
    dataSource,
    /** 备用源模式名(主源失败后尝试); 留空 = 无备用 */
    backupSource,
    /** 解析后的尝试顺序(去重, 恒以 bdon.moe 收尾) */
    sourceChain,
    /** 玩家查询优先源(PLAYER_SOURCE 原文; 为空 = 跟随通用链) */
    playerSource,
    /** 按数据角色覆盖尝试顺序(目前只有 site = 玩家查询; 见 PLAYER_SOURCE) */
    sourceChainByRole,
    metaBase: trimSlash(canonical.metaBase),
    assetBase: trimSlash(canonical.assetBase),
    /** rankd 游戏数据(公告/排行): 公开只读, 无鉴权 */
    gameApiBase: trimSlash(canonical.gameApiBase),
    /** moenotes 站点: 玩家档案公开接口与国旗图标 */
    moenotesSiteBase: trimSlash(canonical.moenotesSiteBase),
    /** 可选的 moenotes-api 自建网关(能查任意玩家); 未配置时玩家查询回退站点公开接口 */
    moenotesApiBase: envStr('MOENOTES_API_BASE', '').replace(/\/+$/, ''),
    moenotesApiKey: envStr('MOENOTES_API_KEY', ''),
    /**
     * 网页平台(web/) 的地址 —— 账号包查询与 bot 绑定码兑换走它的 /api/bot/*。
     * 与网页的 WEB_BOT_TOKEN 必须填同一个值, 否则账号包相关功能按「未对接」处理。
     */
    webPlatformBase: envStr('WEB_PLATFORM_BASE', 'http://127.0.0.1:3003').replace(/\/+$/, ''),
    webPlatformToken: envStr('WEB_PLATFORM_TOKEN', ''),
    cacheDir: path.resolve(envStr('CACHE_DIR', './cache')),
    /**
     * 默认服务器回退链(逗号分隔; 首项即默认服)。
     * 别名可用; 归一化/去重/补全在 Server.ts serverChainList()。语言随服务器档案切换,
     * 回退到下一个服时语言一并回退。
     */
    serverChain,
    /** 缺省区域(链首项的原始写法): /health 与启动日志沿用 */
    defaultServer: serverChain[0] ?? 'tw',
    /** 公告轮询间隔(SSE 推送的延迟来源) */
    announcementPollS: envInt('ANNOUNCEMENT_POLL_S', 300),
    /** 榜线(各档分数)记录间隔(秒): 每小时落一个采样点 */
    cutoffRecordIntervalS: envInt('CUTOFF_RECORD_INTERVAL_S', 3600),
    /**
     * 榜线采样点的聚合粒度(秒)。同一桶内的多次采样互相覆盖, 默认 3600(整点桶)。
     * 调小只对自检有意义(几秒一个桶就能在假上游上攒出多点的折线), 生产保持默认。
     */
    cutoffBucketS: envInt('CUTOFF_BUCKET_S', 3600),
    /**
     * 用户查询触发的榜线采样的冷却(秒): 距上次采样不足该值就跳过采样, 直接用已有数据出图。
     * 默认 300, 与 RANKING_TTL 对齐 —— 更频繁地重采拿到的还是同一份上游缓存。
     * 定时采样不受此限制; 0 = 关闭冷却(每次查询都采)。
     */
    cutoffQueryRecordMinIntervalS: Math.max(0, envInt('CUTOFF_QUERY_RECORD_MIN_INTERVAL_S', 300)),
    /** 谱面效率数据(music-data.json, 站点「歌曲meta」同源); 随游戏版本更新 */
    musicDataUrl: trimSlash(canonical.musicDataUrl),
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
    /**
     * 数据库 API(榜线历史的优先存储; 与 ENABLE_DB 无关)。
     * 数据库凭据与全部 SQL 都在该服务里, 本进程只发语义化请求。
     * DB_API_BASE_URL 为空 = 不启用远程存储, 直接用 SQLite 兜底;
     * 连不上/超时同样回退 SQLite, 由运行时的恢复探测自动切回并回灌。
     */
    dbApiBaseUrl: envStr('DB_API_BASE_URL', '').replace(/\/+$/, ''),
    dbApiToken: envStr('DB_API_TOKEN', ''),
    /** 单次请求超时(毫秒); 超时按不可用处理, 由上层降级 */
    dbApiTimeoutMs: envInt('DB_API_TIMEOUT_MS', 10000),
    /** 榜线历史的 SQLite 回退/缓冲文件(MySQL 不可用时写入, 恢复后自动回灌); 解析方式同 cacheDir */
    sqlitePath: path.resolve(envStr('SQLITE_PATH', './data/tomori.sqlite')),
    /** 车站房间有效期(秒): 默认同 tsugu 的 150 秒 */
    stationTtlS: envInt('STATION_TTL_S', 150),
    /** 单条用户关键词的长度上限(字) */
    maxKeywordLength: envInt('MAX_KEYWORD_LENGTH', 32),
    /** 单个实体可挂的用户关键词数量上限 */
    maxKeywordsPerEntity: envInt('MAX_KEYWORDS_PER_ENTITY', 20),
    gachaDefaultRates: envJson<Record<string, number>>('GACHA_DEFAULT_RATES', { '2': 88.5, '3': 8.5, '4': 3.0 }),
    /** 上游请求的 User-Agent; 留空则用内置默认(带运行时 Node 版本) */
    userAgent: envStr('USER_AGENT', `tomori/0.1 (Node ${process.version})`)
};

export { ttl } from './ttl';
