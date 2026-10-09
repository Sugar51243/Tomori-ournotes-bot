/**
 * 数据源「取数计划」的共享形状 —— 布局翻译器(upstream/sources/*.ts)的输出。
 *
 * 由 chain 统一调度: 每个源把「规范化 bdon 布局请求」翻译成自己的 URL 与数据格式,
 * 翻译器本身是纯函数, 不发起任何请求。
 */
export interface SourceFetchPlan {
    url: string;
    /**
     * 取到的字节在返回前过一道转换(如: yume 的 SPA HTML → bdon 形状清单;
     * haneoka 的响应 → bdon rankd 形状)。抛错 = 视同该源失败, 链继续下一个。
     */
    transform?: (data: Buffer) => Buffer;
    /**
     * 从响应体里解出「上游数据更新时间」的钩子。
     * bdon 的 rankd 把时间放在 ETag 里(见 ranking/client.ts), haneoka 直接给了 fetchedAtMs 字段 ——
     * 让翻译器自己声明怎么取, 链把它带进 FetchedBuffer.upstreamAt, 调用方无需分辨数据源。
     */
    deriveUpstreamAt?: (data: Buffer) => number | undefined;
}
