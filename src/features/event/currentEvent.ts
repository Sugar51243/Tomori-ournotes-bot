import { Server, serverProfile } from '../types/Server';
import { EventPhase, eventPhaseLabel } from '../types/EventPhase';

/**
 * 「当前没有进行中的活动」的统一文案(活动歌榜 / 榜线 / 推荐曲共用)。
 *
 * 上游在活动结束后仍会把旧活动挂在 /events/current 上(见 upstream/events/client.ts),
 * 所以这里把那个活动带出来, 让用户知道可以带上 id 查往期, 而不是只丢一句"没有活动"。
 */
export function noCurrentEventText(
    server: Server,
    finished: { eventId: number; phase: EventPhase } | undefined,
    /** 往期可查的东西: 歌榜 / 榜线 / 推荐曲 */
    noun: string
): string {
    const base = '错误: 该服务器当前没有进行中的活动';
    if (!finished) return base;

    const name = serverProfile(server).displayName;
    if (finished.phase === 'feature') return `${base}；${name}下一期活动 ${finished.eventId} 尚未开始`;
    const stage = eventPhaseLabel(finished.phase);
    return `${base}；${name}上游仍保留活动 ${finished.eventId}（${stage}）的数据，可带上该活动 ID 查往期${noun}`;
}
