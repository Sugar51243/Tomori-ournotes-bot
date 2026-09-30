import { config } from '../config';

/**
 * 游戏区域(服务器)。
 *
 * Our Notes 有四个区域,内部统一用短码 tw/jp/kr/en。注意三套上游命名并不一致:
 * - `metadata.bdon.moe/current_version.json` 用 `hk-tw-mo` 作**清单键**(港澳台服)
 * - master 表的 URL 路径段却是 `tw`(`/tw/master/...`),`hk-tw-mo` 作路径会 404
 * - 素材用 `assets.bdon.moe/{assetRegion}/{locale}/...`
 * `hk-tw-mo` 作为**别名**继续被接受(老 tsugu 客户端与已登记的交友记录都这么传)。
 */
export type Server = 'tw' | 'jp' | 'kr' | 'en';

export const SERVER_LIST: readonly Server[] = ['tw', 'jp', 'kr', 'en'];

/** 请求体里允许出现的区域写法 -> 规范短码 */
const SERVER_ALIASES: Record<string, Server> = {
    tw: 'tw',
    'hk-tw-mo': 'tw',
    hk: 'tw',
    jp: 'jp',
    kr: 'kr',
    en: 'en'
};

export interface ServerProfile {
    server: Server;
    /** 出图用的展示名 */
    displayName: string;
    /** current_version.json 里 regions 的键 */
    masterdataKey: string;
    /** master 表 URL 的路径段 */
    masterPath: string;
    /** 素材 CDN 的区域段 */
    assetRegion: string;
    /** 该区域素材 CDN 上真实存在的语言目录(jp 只有 ja) */
    assetLocales: string[];
    /** 取文本/取图的默认语言 */
    defaultLocale: string;
    /** 文本回退链里追加在 defaultLocale 之后的语言(不含全局 en/ja 兜底) */
    localeFallbacks: string[];
    /** 主数据里的“本地时间”相对 UTC 的偏移(分钟) */
    utcOffsetMinutes: number;
    timeZone: string;
    /** bdon.moe/flags 下的国旗文件名 */
    flagFile: string;
}

const ALL_LOCALES = ['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'];

const PROFILES: Record<Server, ServerProfile> = {
    tw: {
        server: 'tw',
        displayName: '港澳台服',
        masterdataKey: 'hk-tw-mo',
        masterPath: 'tw',
        assetRegion: 'tw',
        assetLocales: ALL_LOCALES,
        // 港澳台服**优先出简体中文**(用户指定), 繁体退居其后
        defaultLocale: 'zh-Hans',
        localeFallbacks: ['zh-Hant', 'ja', 'en'],
        utcOffsetMinutes: 480,
        timeZone: 'Asia/Taipei',
        flagFile: 'hk'
    },
    jp: {
        server: 'jp',
        displayName: '日服',
        masterdataKey: 'jp',
        masterPath: 'jp',
        assetRegion: 'jp',
        // jp 素材只有日文目录: assets.bdon.moe/jp/zh-Hans/... 实测一律 404
        assetLocales: ['ja'],
        defaultLocale: 'ja',
        // jp 的 MasterText 中文列基本为空(9924 行里仅 60 行有值), 回退链必须落到 ja
        localeFallbacks: [],
        utcOffsetMinutes: 540,
        timeZone: 'Asia/Tokyo',
        flagFile: 'jp'
    },
    kr: {
        server: 'kr',
        displayName: '韩服',
        masterdataKey: 'kr',
        masterPath: 'kr',
        assetRegion: 'kr',
        assetLocales: ALL_LOCALES,
        defaultLocale: 'ko',
        localeFallbacks: ['ja', 'en'],
        utcOffsetMinutes: 480,
        timeZone: 'Asia/Seoul',
        flagFile: 'kr'
    },
    en: {
        server: 'en',
        displayName: '国际服',
        masterdataKey: 'en',
        masterPath: 'en',
        assetRegion: 'en',
        assetLocales: ALL_LOCALES,
        defaultLocale: 'en',
        localeFallbacks: ['ja'],
        utcOffsetMinutes: 480,
        timeZone: 'UTC',
        flagFile: 'us'
    }
};

export function serverProfile(server: Server): ServerProfile {
    return PROFILES[server];
}

/** 归一化任意输入为规范短码;无法识别返回 undefined */
export function normalizeServer(value: unknown): Server | undefined {
    if (typeof value !== 'string') return undefined;
    return SERVER_ALIASES[value.trim().toLowerCase()];
}

/**
 * 配置里的缺省区域(config.DEFAULT_SERVER 是字符串, 无法直接标成 Server —— 会与 config 形成循环导入)。
 * 领域模型用它做 `server` 字段的初值。
 */
export function defaultServer(): Server {
    return normalizeServer(config.defaultServer) ?? 'tw';
}

/** express-validator 用: 接受规范短码与别名 */
export function isServer(value: unknown): value is Server {
    return normalizeServer(value) !== undefined;
}

export function isServerList(value: unknown): value is Server[] {
    return Array.isArray(value) && value.every(isServer);
}

/** 各服的展示名(带 html 兜底, 供未知的历史取值使用) */
export function serverDisplayName(value: unknown): string {
    const server = normalizeServer(value);
    return server ? PROFILES[server].displayName : String(value ?? '');
}

/**
 * 静态实体接口(歌曲/卡/角色/活动/歌表): 决定这一张图里要画哪几个服。
 * displayedServerList 按传入顺序去重 -> mainServer -> 默认全部四服。
 */
export function pickServers(body: { displayedServerList?: unknown; mainServer?: unknown }): Server[] {
    const out: Server[] = [];
    const push = (v: unknown) => {
        const s = normalizeServer(v);
        if (s && !out.includes(s)) out.push(s);
    };
    if (Array.isArray(body?.displayedServerList)) body.displayedServerList.forEach(push);
    push(body?.mainServer);
    return out.length ? out : [...SERVER_LIST];
}

/**
 * 动态用户数据接口(排行榜/账号/公告): 一次只查一个服。
 * 新字段 `server` 优先, 兼容 tsugu 的 `mainServer`;都缺省时用 config.defaultServer。
 */
export function pickServer(body: { server?: unknown; mainServer?: unknown; displayedServerList?: unknown }): Server {
    const listed = Array.isArray(body?.displayedServerList) ? body.displayedServerList[0] : undefined;
    return normalizeServer(body?.server)
        ?? normalizeServer(body?.mainServer)
        // 老客户端只会传 displayedServerList, 取首项作为单服的兜底
        ?? normalizeServer(listed)
        ?? defaultServer();
}

// ---- 兼容旧调用点保留的导出 ----

export const serverList: Server[] = [...SERVER_LIST];

export const globalDefaultServer: Server[] = [...SERVER_LIST];

/** 交友登记: 四个区域都是合法游戏区域(历史上还允许 hk-tw-mo 别名) */
export type FriendServer = Server;

export const friendServerList: readonly FriendServer[] = SERVER_LIST;

export function isFriendServer(value: unknown): value is FriendServer {
    return normalizeServer(value) !== undefined;
}

export function getServerByServerId(serverId: unknown): Server {
    return normalizeServer(serverId) ?? defaultServer();
}

export function getServerByPriority(displayedServerList: unknown): Server {
    return pickServers({ displayedServerList })[0];
}

/**
 * 内部构造实体时把当前区域传下去(领域模型的构造函数只收 id, 区域是构造后的字段)。
 * 例: `const band = withServer(new Band(id), this.server); await band.init();`
 */
export function withServer<T extends { server: Server }>(entity: T, server: Server): T {
    entity.server = server;
    return entity;
}
