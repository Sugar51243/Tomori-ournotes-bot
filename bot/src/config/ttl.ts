/**
 * 上游缓存 TTL(秒): 纯代码常量 —— 不走 .env、不可通过环境变量覆盖, 需要调整时改这里并重新构建。
 *
 * 单位均为秒; 语义与各自的消费端一致(见注释)。
 */
export const ttl = {
    /** 各服 master 表缓存 */
    masterdataTtlS: 3600,
    /** 版本清单(current_version.json)缓存 */
    versionTtlS: 600,
    /** 谱面清单缓存 */
    chartManifestTtlS: 604800,
    /** 谱面资源(内容寻址, sha 不变即内容不变)缓存 */
    chartAssetTtlS: 2592000,
    /** 游戏图片缓存 */
    imageTtlS: 604800,
    /** 公告列表/详情缓存(上游 Cache-Control: max-age=300) */
    announcementTtlS: 300,
    /** 歌曲/活动排行缓存 */
    rankingTtlS: 300,
    /** 谱面效率数据 music-data.json(随游戏版本更新) */
    musicDataTtlS: 86400,
    /** 玩家档案缓存(仅进程内, 不落盘) */
    playerTtlS: 300,
    // 这里原本还有个 webAccountTtlS(网页账号包摘要 60s)。已经删掉:
    // 那份摘要里带着公开开关/数据更新时间/主数据版本, 它本身就是"网页改了什么"的信号,
    // 按时间复用等于让改动迟到(网页上开了道具公开, bot 组卡还回「没有公开道具数据」)。
    // 现在只合并同时在飞的请求, 跨命令一律重新读 —— 见 src/webPlatform/client.ts。
    /**
     * 网页平台的 master bundle(组卡查表用; 按主数据版本变, 一天一问足够)。
     * 取值只是"多久算新鲜"，实际每次都会带 ETag 回源校核(forceRefresh)，版本变了立刻跟上。
     */
    masterBundleTtlS: 86400,
    /** 关键词内存快照的兜底 TTL(上传/删除会主动强刷, 这里只兜底多进程/多实例场景) */
    keywordCacheTtlS: 60
} as const;
