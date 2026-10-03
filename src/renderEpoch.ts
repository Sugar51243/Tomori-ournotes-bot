/**
 * 渲染缓存的世代号。
 *
 * 有些输入既不改 dataVersion, 也不体现在请求体里 —— 目前只有一个: 用户上传/删除的关键词
 * (它会影响详情图的「关键词」栏位, 也会影响模糊搜索的命中)。这类变更发生后调用
 * `bumpRenderEpoch()`, 缓存键里的世代号一变, 旧条目自然不再命中(等 `evict()` 淘汰, 无需清表)。
 *
 * 单独成模块是为了让「写关键词」与「读缓存」两侧都能引用它, 而不必让数据层反向依赖路由层。
 */
let renderEpoch = 0;

/** 世代号 +1: 渲染缓存键的一部分, 调用后旧缓存条目自然失效 */
export function bumpRenderEpoch(): void {
    renderEpoch += 1;
}

/** 当前世代号(渲染缓存键用) */
export function currentRenderEpoch(): number {
    return renderEpoch;
}
