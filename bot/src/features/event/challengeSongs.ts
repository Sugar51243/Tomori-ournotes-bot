import { storeFor } from '../../db/adapter';
import { getEventTracking } from '../../upstream/adapter';
import type { Server } from '../types/Server';

/**
 * 该活动的挑战曲（挑战live 只能选这些）。
 *
 * 先问上游追踪，取不到（或追踪里没有曲目）再退 masterdata 的 MasterChallengeMusic
 * —— 其主键 id 是挑战曲 id，`liveMusicId` 才是曲目 id，与 /eventRanking 同一套兜底。
 *
 * 两处消费：`/eventRecommend` 的挑战live 表、组卡器（活动·挑战live 模式）的曲池。
 * 改行为要同时想到两边。
 */
export async function challengeSongIds(server: Server, eventId: number): Promise<number[]> {
    const tracking = await getEventTracking(server, eventId).catch(() => undefined);
    if (tracking?.status === 'ok' && tracking.track.songs.length) {
        return [...new Set(tracking.track.songs.map(s => s.musicId))];
    }
    const rows = await storeFor(server).challengeMusicByEvent(eventId).catch(() => []);
    return [...new Set(rows.map(r => Number(r.liveMusicId)).filter(Number.isFinite))];
}
