import { withServer } from '../types/Server';
import { Song } from '../types/Song';
import { firstOwner } from '../song/songOwner';
import { getAccountData, lookupAccount, WebPlatformError, webPlatformConfigured } from '../../webPlatform/client';
import { resolvePlayerTarget } from './playerBind';
import type { BindQuery } from './playerBind';
import { drawB25List, B25Row } from '../../render/view/player/b25List';

/**
 * B25（BEST 25 计分榜）。
 *
 * 数据来自网页账号包里导入时算好的 `songs_data.b25`（与网页「B25」同一份结果：
 * 计入值 AP 记谱面等级、FC 记等级-1，取全账号前 25 张谱面）。**需要该账号包的歌曲公开** ——
 * 隐藏时网页直接 404，绑定本人也一样（见 src/webPlatform/client.ts 的隐私口径）。
 *
 * 曲名/封面按「所选服 → 港澳台 → 日服」的顺序查主数据（与歌曲meta 同一套兜底）。
 */

export interface B25Query extends BindQuery {
    compress?: boolean;
}

/** 网页存的 b25 行: [musicId, difficulty(0-3), 计入值, 谱面显示等级, 分数] */
type RawB25Entry = [number, number, number, number, number];

export async function commandB25(query: B25Query): Promise<Array<Buffer | string>> {
    const target = await resolvePlayerTarget(query);
    if (target.status === 'error') return [target.message];
    if (!webPlatformConfigured()) {
        return ['错误: 未对接网页平台（b25 需要网页账号包数据；在 bot 配置 WEB_PLATFORM_TOKEN 后可用）'];
    }

    let account;
    let songStatus;
    try {
        const lookup = await lookupAccount(target.playerId, target.server);
        account = lookup.account;
        songStatus = lookup.songStatus;
    } catch (e) {
        if (e instanceof WebPlatformError) {
            if (e.kind === 'not_found') return [`该玩家还没有在网页导入账号包（b25 需要账号包数据）：${target.playerId}`];
            return [`错误: ${e.message}`];
        }
        throw e;
    }

    if (!account.visible.songs) {
        return [`该账号没有公开歌曲数据（b25 需要歌曲可见；可到网页「我的账号」里调整公开开关）`];
    }

    let raw: Record<string, unknown> | null;
    try {
        raw = (await getAccountData(account.id, 'songs')).data;
    } catch (e) {
        if (e instanceof WebPlatformError && e.kind === 'not_found') return ['该账号没有公开歌曲数据（可到网页调整公开开关）'];
        if (e instanceof WebPlatformError) return [`错误: ${e.message}`];
        throw e;
    }

    const b25 = (raw?.b25 ?? {}) as { top?: RawB25Entry[]; totalRating?: number };
    const top = Array.isArray(b25.top) ? b25.top : [];
    if (!top.length) return [`该账号的 b25 数据是空的（导入时的账号包可能太旧，重新导入一次网页账号包）`];

    const rows: B25Row[] = [];
    for (const entry of top) {
        const [musicId, difficulty, counted, level, score] = entry;
        const song = withServer(new Song(Number(musicId)), await firstOwner(Number(musicId), target.server));
        await song.init();
        rows.push({
            musicId: Number(musicId),
            difficulty: Number(difficulty),
            counted: Number(counted),
            level: Number(level),
            score: Number(score),
            song: song.isExist ? song : undefined
        });
    }

    return [await drawB25List(target.server, {
        playerId: target.playerId,
        title: account.label || account.playerName || target.playerId,
        totalRating: Number(b25.totalRating ?? 0),
        totalSongs: songStatus?.total,
        rows
    }, query.compress ?? false)];
}
