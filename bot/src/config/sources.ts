/**
 * 上游数据源档案: 一个模式名对应一套取数方式(URL 布局 + 可承担的数据角色),
 * 由 .env 的 DATA_SOURCE / BACKUP_SOURCE 选择优先级; bdon.moe 是恒定的最终兜底。
 *
 * 具体网址写在这里(而非 .env) —— .env 只保留模式名做识别; 接入新源时在此新增档案。
 */

/** 数据角色: 链按角色分发, 每个源只参与自己声明的角色 */
export type SourceRole = 'meta' | 'asset' | 'gameApi' | 'site' | 'musicData' | 'chartSite';

/** URL 布局方言: 'bdon' = 规范化布局(恒等); 其它由 upstream/sources/ 下的翻译器处理 */
export type SourceLayout = 'bdon' | 'yume' | 'haneoka';

export interface DataSourceProfile {
    /** URL 布局方言 */
    layout: SourceLayout;
    /** 该源可承担的角色; 未声明的角色直接跳过该源 */
    roles: readonly SourceRole[];
    /** 版本清单(current_version.json)与各服 master 表 */
    metaBase: string;
    /** 游戏图片素材与谱面站资源 */
    assetBase: string;
    /** rankd 游戏数据(公告/活动/排行): 公开只读, 无鉴权 */
    gameApiBase: string;
    /** moenotes 站点: 玩家公开档案接口与国旗图标 */
    moenotesSiteBase: string;
    /** 谱面效率数据 music-data.json(站点「歌曲meta」同源) */
    musicDataUrl: string;
    /**
     * 该源的"版本来源页面"(yume 布局用): 页面 HTML 内嵌版本标记,
     * 用于合成 bdon 形状的版本清单。仅 layout != 'bdon' 的档案需要。
     */
    versionSourceUrl?: string;
}

/** 内置数据源档案表: 键为 .env 里 DATA_SOURCE / BACKUP_SOURCE 用的模式名 */
export const DATA_SOURCES: Readonly<Record<string, DataSourceProfile>> = {
    'bdon.moe': {
        layout: 'bdon',
        roles: ['meta', 'asset', 'gameApi', 'site', 'musicData', 'chartSite'],
        metaBase: 'https://metadata.bdon.moe',
        assetBase: 'https://assets.bdon.moe',
        gameApiBase: 'https://api.bdon.moe',
        moenotesSiteBase: 'https://bdon.moe',
        musicDataUrl: 'https://storage.bdon.moe/moenotes/music-data/music-data.json'
    },
    /**
     * Project Yume: BanG Dream! Our Notes 自制数据库(https://bdon.yatta.moe)。
     * 只承担 meta(原始 master 表, 34/35 张齐全, 行/键与 bdon 一致)与 asset(图片, 路径去掉重复末段)。
     * 只有一份 en 数据集(四个区域都映射到它); 没有 current_version.json, 版本由站点页面标记合成。
     */
    'bdon.yatta.moe': {
        layout: 'yume',
        roles: ['meta', 'asset'],
        metaBase: 'https://bdon.yatta.moe/Resources/en/Master',
        assetBase: 'https://bdon.yatta.moe/Resources/en/Assets/AddressableResources',
        gameApiBase: '',
        moenotesSiteBase: '',
        musicDataUrl: '',
        versionSourceUrl: 'https://bdon.yatta.moe/info/characters'
    },
    /**
     * haneoka.org(BanG Dream! Our Notes 数据库, https://haneoka.org)。
     * 承担 gameApi(活动/曲榜排行)、site(玩家查询)与 musicData(乐曲分析)三个角色:
     * - gameApi/site 与 bdon rankd 是**同一份数据**(逐条比对过), 等价可替换;
     * - 玩家查询能查任意日服玩家(比站点公开接口宽);
     * - musicData 是**降级模型**: 站点「乐曲分析」直接给效率/物量等结果, 没有 bdon
     *   music-data.json 的种子模型(技能权重/评级门槛), 详情见 upstream/sources/haneoka.ts。
     *
     * ⚠ 剧透(超前内容): 上游作者声明不可接入超前内容 —— 本档案只访问**发行数据集**
     * (catalog 固定 intl, game records 只用 tw/jp/kr/en), 从不请求 -cbt/-test 数据集。
     */
    'haneoka.org': {
        layout: 'haneoka',
        roles: ['gameApi', 'site', 'musicData'],
        metaBase: '',
        assetBase: '',
        gameApiBase: 'https://haneoka.org',
        moenotesSiteBase: 'https://haneoka.org',
        musicDataUrl: ''
    }
};

/** 环境变量缺省值 */
export const DEFAULT_DATA_SOURCE = 'bdon.moe';
/** 恒定最终兜底(也是规范化 URL 的布局来源) */
export const FALLBACK_DATA_SOURCE = 'bdon.moe';
