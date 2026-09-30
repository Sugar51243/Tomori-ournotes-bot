import { config } from '../../config';
import { cachedFetch } from '../cachedFetch';
import { Server } from '../../types/Server';
import { MusicRanking, RankingEntry } from '../../types/Ranking';

/**
 * 歌曲排行客户端(rankd 公开接口)。
 * 单首歌的响应约 140KB, 必须走磁盘缓存 —— 否则反复查询会把上游和出图都拖死。
 */

interface RawPlayer {
    score?: number;
    playerData?: {
        id?: string;
        name?: string;
        favoriteMemberCard?: { cardId?: string };
    };
    highScoreDeck?: { cards?: Array<{ memberCard?: { cardId?: string } }> };
}

function toEntries(players: RawPlayer[]): RankingEntry[] {
    return players.map((p, i) => ({
        rank: i + 1,
        score: Number(p.score ?? 0),
        playerId: String(p.playerData?.id ?? ''),
        playerName: String(p.playerData?.name ?? ''),
        cardId: p.playerData?.favoriteMemberCard?.cardId
            ?? p.highScoreDeck?.cards?.[0]?.memberCard?.cardId
    }));
}

/** 取某服某首歌的前十名; 上游无数据时返回空列表 */
export async function getMusicRanking(server: Server, musicId: number, limit = 10): Promise<MusicRanking> {
    const empty: MusicRanking = { server, musicId, entries: [] };
    const res = await cachedFetch(`${config.gameApiBase}/api/v1/${server}/music/${musicId}/ranking`, {
        key: `ranking/${server}/music_${musicId}.json`,
        ttlS: config.rankingTtlS,
        allowStale: true,
        revalidate: true
    }).catch(() => undefined);
    if (!res) return empty;
    try {
        const body = JSON.parse(res.data.toString('utf8')) as { players?: RawPlayer[] };
        if (!Array.isArray(body.players)) return empty;
        return { server, musicId, entries: toEntries(body.players.slice(0, Math.max(1, limit))) };
    } catch {
        return empty;
    }
}
