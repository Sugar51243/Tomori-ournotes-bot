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
 * 服务器输入统一为一个字段 `displayedServerList`, **单值、列表、缺省都接受**:
 * 传单个服(`"jp"`)等价于只含该服的列表; 按传入顺序归一化并去重。
 */
export function normalizeServerInput(value: unknown): Server[] {
    const out: Server[] = [];
    const push = (v: unknown) => {
        const s = normalizeServer(v);
        if (s && !out.includes(s)) out.push(s);
    };
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
    return out;
}

/** express-validator 用: 接受单个服、服列表或缺失 */
export function isServerInput(value: unknown): boolean {
    return isServer(value) || isServerList(value);
}

/**
 * 多服 / 单服回退: 输入的服按顺序全部保留; 缺省时用全部四服。
 * - 多服端点: 输入了几个服就同时使用几个服的数据
 * - 单服回退端点: 按此顺序依次查询, 取第一个命中的服
 */
export function pickServers(body: { displayedServerList?: unknown }): Server[] {
    const list = normalizeServerInput(body?.displayedServerList);
    return list.length ? list : [...SERVER_LIST];
}

/**
 * 单服: 只取输入列表的首项(传单值即该服), **不允许回退**;
 * 缺省时用 config.defaultServer。
 */
export function pickServer(body: { displayedServerList?: unknown }): Server {
    return normalizeServerInput(body?.displayedServerList)[0] ?? defaultServer();
}

/** 请求是否显式带了服务器输入(账号查询的 ID 前缀推断等用) */
export function hasServerInput(body: { displayedServerList?: unknown }): boolean {
    return normalizeServerInput(body?.displayedServerList).length > 0;
}

/**
 * 单服回退端点的完整回退链: 输入的服按顺序优先, 其后补齐其余服(四服顺序)。
 * 缺省输入时即全部四服 —— 依次查询, 取第一个命中的服。
 */
export function fallbackChain(body: { displayedServerList?: unknown }): Server[] {
    const list = normalizeServerInput(body?.displayedServerList);
    return [...list, ...SERVER_LIST.filter(s => !list.includes(s))];
}

/** 交友登记: 四个区域都是合法游戏区域(历史上还允许 hk-tw-mo 别名) */
export type FriendServer = Server;

export function isFriendServer(value: unknown): value is FriendServer {
    return normalizeServer(value) !== undefined;
}

/**
 * 内部构造实体时把当前区域传下去(领域模型的构造函数只收 id, 区域是构造后的字段)。
 * 例: `const band = withServer(new Band(id), this.server); await band.init();`
 */
export function withServer<T extends { server: Server }>(entity: T, server: Server): T {
    entity.server = server;
    return entity;
}
