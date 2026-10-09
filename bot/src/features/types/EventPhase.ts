/**
 * 活动阶段(上游 rankd 活动对象的 `eventStatus`, 与站点 bdon.moe 活动追踪器同词)。
 *
 * 上游**在活动结束后仍会把旧活动挂在 /events/current 上**(实测: 活动结束后 eventStatus 变
 * result/aggregation), 所以「现在有没有活动进行中」必须看阶段, 不能只看上游有没有返回活动。
 *
 * 判断「进行中」一律用这里的谓词, 不要自己写 `=== 'nowOn'` —— 阶段可能未知(上游缺字段/时间
 * 不可解析), 未知时**保守放行**(见 mayBeRunning), 免得上游一改字段就把功能全判成"没活动"。
 *
 * 注意: masterdata(MasterEvent)只有起止时间, **推不出「集计中/结果公布」** —— 那两个阶段
 * 只有上游能给; 用时间推导时一律把结算展示期归入「已结束」, 宁可少标也不要标错。
 */

export type EventPhase = 'feature' | 'nowOn' | 'aggregation' | 'result' | 'end';

/** 阶段展示名(与站点 i18n 的简中文案一致) */
export const EVENT_PHASE_LABELS: Record<EventPhase, string> = {
    feature: '即将开始',
    nowOn: '进行中',
    aggregation: '集计中',
    result: '结果公布',
    end: '已结束'
};

/** 阶段展示名; 阶段未知返回空串(出图据此不标注) */
export function eventPhaseLabel(phase?: EventPhase): string {
    return phase ? EVENT_PHASE_LABELS[phase] : '';
}

/** 上游 eventStatus -> 阶段; 不认识的值/缺字段 -> undefined */
export function parseEventPhase(raw: unknown): EventPhase | undefined {
    // 用 hasOwn 而不是 in: in 会把 toString 之类的原型属性也当成合法阶段
    return typeof raw === 'string' && Object.hasOwn(EVENT_PHASE_LABELS, raw) ? raw as EventPhase : undefined;
}

/**
 * 用上游对象**自带**的 endAt 纠偏, 只降不升: 说「进行中」但同一份数据里的 endAt 已过 -> 已结束。
 *
 * 上游响应会进磁盘缓存(榜单类 TTL 5 分钟, 且网络故障时允许无限期回退陈旧副本) ——
 * 不纠偏的话, 网络抖动期间会把已结束的活动一直当进行中: 采样器持续采它、默认查询也拿它当当前活动。
 * 反过来不做「即将开始 -> 进行中」的升级: 上游阶段权威, 时间只兜底。
 */
export function adjustEventPhaseByTime(phase: EventPhase | undefined, endAt?: number, now = Date.now()): EventPhase | undefined {
    return phase === 'nowOn' && endAt !== undefined && now > endAt ? 'end' : phase;
}

/** 已知在进行中(阶段未知时为 false) */
export function isEventRunning(phase?: EventPhase): boolean {
    return phase === 'nowOn';
}

/** 已知不在进行中(阶段未知时为 false): 只有它为 true 才该走「已结束/未开始」分支 */
export function isEventNotRunning(phase?: EventPhase): boolean {
    return phase !== undefined && phase !== 'nowOn';
}

/** 不排除进行中(阶段未知时为 true): 采样这类「宁可多采一次」的场景用它 */
export function mayBeRunning(phase?: EventPhase): boolean {
    return phase === undefined || isEventRunning(phase);
}
