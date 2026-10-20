import dotenv from 'dotenv';

dotenv.config();

function envStr(key: string, def: string): string {
    const v = process.env[key];
    return v === undefined || v === '' ? def : v;
}

function envInt(key: string, def: number): number {
    const n = Number(process.env[key]);
    return Number.isFinite(n) ? n : def;
}

function envBool(key: string, def: boolean): boolean {
    const v = process.env[key];
    if (v === undefined || v === '') return def;
    return /^(1|true|yes|on)$/i.test(v);
}

/** 逗号分隔的列表; 空串 → 空数组 */
function envList(key: string): string[] {
    return envStr(key, '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

export interface ClientToken {
    /** 消费方名字(bot / web / …); 只用于日志与限流分桶 */
    name: string;
    token: string;
}

/**
 * DB_API_TOKENS 解析: `bot=<token>,web=<token>` 形式的逗号分隔表。
 * 省略 `名字=` 前缀时整段当 token, 名字记作 unnamed(兼容只想先跑起来的场景)。
 */
function parseTokens(raw: string): ClientToken[] {
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(entry => {
            const eq = entry.indexOf('=');
            if (eq <= 0) return { name: 'unnamed', token: entry };
            return { name: entry.slice(0, eq).trim(), token: entry.slice(eq + 1).trim() };
        })
        .filter(t => t.token.length > 0);
}

const nodeEnv = envStr('NODE_ENV', 'development');
const production = nodeEnv === 'production';
const location = envStr('DB_API_LOCATION', '127.0.0.1');

/**
 * 数据库 API 服务配置。它同时服务 bot(榜线)与 web(社区/账号), 所以环境变量
 * 统一用 DB_API_ / MYSQL_ / MONGODB_ 前缀, 不带任何一方的私有前缀。
 */
export const config = {
    nodeEnv,
    production,
    port: envInt('DB_API_PORT', 3004),
    location,
    logLevel: envStr('DB_API_LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
    /** 反代层数; 部署在 nginx/caddy 之后设为 1, 否则 req.ip 全是反代地址(IP 白名单/限流会误判) */
    trustProxy: envInt('DB_API_TRUST_PROXY', 0),

    // ---- 鉴权 ----
    /** 允许的访问令牌表(名字用于日志/限流, token 本身常量时间比对) */
    tokens: parseTokens(envStr('DB_API_TOKENS', '')),
    /** 可选的 IP 白名单(逗号分隔); 空 = 不限制。公网部署建议配上 */
    ipAllowlist: envList('DB_API_IP_ALLOWLIST'),
    /** 每 client(令牌)每分钟请求上限; 正常批量读写远低于它, 只用来兜住失控循环 */
    rateLimitPerMin: envInt('DB_API_RATE_LIMIT_PER_MIN', 1200),
    /** 未鉴权端点(健康检查)每 IP 每分钟上限 */
    rateLimitIpPerMin: envInt('DB_API_RATE_LIMIT_IP_PER_MIN', 60),

    // ---- 自带 https 监听(可选; 公网部署的两种方式之一, 另一种是反代终止) ----
    /** https 监听端口; **0 = 不监听**。要和 sslCert/sslKey 一起配才生效 */
    httpsPort: envInt('DB_API_HTTPS_PORT', 0),
    /**
     * https 监听的绑定地址; 默认跟随 DB_API_LOCATION。
     * 公网部署的推荐姿势: DB_API_LOCATION=127.0.0.1(明文口只给本机) +
     * DB_API_HTTPS_LOCATION=0.0.0.0(加密口对外) —— 令牌永远不会走明文。
     */
    httpsLocation: envStr('DB_API_HTTPS_LOCATION', location),
    sslCert: envStr('DB_API_SSL_CERT', ''),
    sslKey: envStr('DB_API_SSL_KEY', ''),

    // ---- MySQL ----
    mysql: {
        host: envStr('MYSQL_HOST', '127.0.0.1'),
        port: envInt('MYSQL_PORT', 3306),
        user: envStr('MYSQL_USER', 'root'),
        password: envStr('MYSQL_PASSWORD', ''),
        /** web 的平台库(账号/论坛/自制谱/聊天等 web_* 表) */
        database: envStr('MYSQL_DATABASE', 'tomori_web'),
        /** bot 的库(cutoff_samples/cutoff_meta 榜线表) */
        botDatabase: envStr('MYSQL_BOT_DATABASE', 'tomori'),
        connectTimeoutMs: envInt('MYSQL_TIMEOUT_MS', 5000),
    },

    // ---- MongoDB(与原先 bot/web 直连的是同一个库同一批集合) ----
    mongo: {
        uri: envStr('MONGODB_URI', 'mongodb://127.0.0.1:27017'),
        db: envStr('MONGODB_DB', 'tomori'),
        timeoutMs: envInt('MONGO_TIMEOUT_MS', 3000),
    },

    // ---- 业务常量 ----
    /** 车站房号有效期(秒)。原先 bot 的 STATION_TTL_S 与 web 的 WEB_STATION_TTL_S 必须一致, 现在只此一处 */
    stationTtlS: envInt('STATION_TTL_S', 150),

    /** 请求体上限(MB); 自制谱 chart_data 有几百 KB, 留足余量 */
    bodyLimitMb: envInt('DB_API_BODY_LIMIT_MB', 8),
} as const;

/** 生产环境的致命配置缺失在启动时就要报出来, 而不是等到第一个请求 */
export function assertConfig(): void {
    if (config.tokens.length === 0) {
        const msg = 'DB_API_TOKENS 未配置 —— 服务将拒绝一切请求。请生成随机令牌: DB_API_TOKENS="bot=<随机串>,web=<随机串>"';
        if (config.production) throw new Error(msg);
        console.warn(`[config] 警告: ${msg}`);
    }
    if (!/^127\.|^localhost$/i.test(config.location) && !(config.httpsPort > 0 && config.sslCert && config.sslKey)) {
        console.warn(
            '[config] 注意: 明文端口正在对外监听且未配置自带 https。公网部署必须挂反代终止 TLS, ' +
                '否则令牌与数据会以明文传输。推荐: DB_API_LOCATION=127.0.0.1 + DB_API_HTTPS_LOCATION=0.0.0.0 + 证书三件套。'
        );
    }
}
