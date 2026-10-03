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
    /** 关键词内存快照的兜底 TTL(上传/删除会主动强刷, 这里只兜底多进程/多实例场景) */
    keywordCacheTtlS: 60
} as const;
