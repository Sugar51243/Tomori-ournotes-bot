import { EventPhase, eventPhaseLabel, isEventNotRunning } from '../../../features/types/EventPhase';

/**
 * 出图上的活动阶段标注(活动歌榜 / 活动榜线共用)。
 *
 * 只有**已知不在进行中**才标注: 进行中与阶段未知都不加, 不给正常情况制造噪声。
 * 阶段来自 `Event.phase()`(上游 eventStatus 优先, 时间兜底), 见 features/types/EventPhase.ts。
 */

/** 标题带后缀(如「活动歌榜 · 结果公布」); 进行中/未知返回空串 */
export function phaseTitleSuffix(phase?: EventPhase): string {
    return isEventNotRunning(phase) ? ` · ${eventPhaseLabel(phase)}` : '';
}

/** 页脚说明行: 活动已结束(附阶段), tail 说明这份数据是什么(如「榜单为上游保留的数据」) */
export function endedPhaseNote(phase: EventPhase | undefined, tail: string): string {
    const stage = eventPhaseLabel(phase);
    // 「已结束」不重复标(没有信息量); 集计中/结果公布标出来, 用户才知道数据可能还会变
    const stageText = stage && stage !== '已结束' ? `（${stage}）` : '';
    return `该活动已结束${stageText}，${tail}`;
}
