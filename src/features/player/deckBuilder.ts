import { Event } from '../types/Event';
import { Song } from '../types/Song';
import { Server, withServer } from '../types/Server';
import { firstOwner } from '../song/songOwner';
import { resolveCurrentEvent, getMusicData } from '../../upstream/adapter';
import { getAccountData, lookupAccount, WebPlatformError, webPlatformConfigured } from '../../webPlatform/client';
import { getMasterBundle } from '../../deck/bundle';
import { optimize } from '../../deck/optimize';
import type { ChartEfficiency } from '../../deck/deck';
import type { GameAccountCardsData, GameAccountItemsData, MasterBundle } from '../../deck/types';
import type { OptimizeEvent, OptimizeResult } from '../../deck/optimize';
import { RANK_NUMBERS } from '../event/eventRecommend';
import { resolvePlayerTarget } from './playerBind';
import type { BindQuery } from './playerBind';
import { drawDeckBuilder } from '../../render/view/player/deckBuilder';

/**
 * 组卡工具（与网页组卡器**同逻辑** —— 算法本体移植自 web/client/src/accountPackage，
 * 见 src/deck/deck.ts 顶部说明；数值一致性由 scripts/verify-deck-port.ts 对照保证）。
 *
 * 数据来源:
 * - 账号包(卡片/道具/T.G.W 等级): 网页平台 `/api/bot/*`（**按公开开关**，隐藏即不可用）;
 * - master bundle: 网页平台公开端点（与网页组卡器同一份查表数据）;
 * - 谱面效率与活动报酬: bot 自己（与 /songMeta、/eventDeckContext 同一份模型）。
 *
 * 模式: normal（最高综合力 + 效率曲）/ event（活动推荐 + 收益/小时）/ auto（有进行中活动则用活动模式）。
 */

export interface DeckQuery extends BindQuery {
    /** normal | event | auto（默认） */
    mode?: unknown;
    /** 指定活动 ID：活动模式按**该活动**的报酬表算（往期/未开始的活动也能用）；不传则 auto 时用进行中的活动 */
    eventId?: unknown;
    /** eventId 的 tsugu 风格别名 */
    id?: unknown;
    compress?: boolean;
}

/** bot 的歌曲meta 数据 → 组卡算法要的谱面效率行（口径与网页的 /chart-efficiency 完全一致） */
function toCharts(data: NonNullable<Awaited<ReturnType<typeof getMusicData>>>): ChartEfficiency[] {
    const DIFFS = ['easy', 'normal', 'hard', 'expert'];
    const out: ChartEfficiency[] = [];
    for (const c of data.charts) {
        const idx = DIFFS.indexOf(c.difficulty);
        if (idx < 0 || !c.free) continue;
        const ranks = c.scoreRanks
            .map(r => [RANK_NUMBERS[r.rank] ?? 0, r.requiredScore ?? 0] as [number, number])
            .filter(([n]) => n > 0)
            .sort((a, b) => a[0] - b[0]);
        out.push({
            musicId: c.musicId,
            difficulty: idx,
            bgmMs: c.bgmMs,
            notes: c.notes,
            displayLevel: c.displayLevel,
            baseFree: c.free.base,
            weightsFree: c.free.weights,
            baseBattle: c.battle?.base ?? 0,
            weightsBattle: c.battle?.weights ?? [],
            ranks
        });
    }
    return out;
}

/** 该活动的演出报酬表（optimize 的活动模式用）；没收录返回 undefined */
async function eventContextById(server: Server, eventId: number): Promise<{ event: OptimizeEvent; name: string } | undefined> {
    const event = withServer(new Event(eventId), server);
    await event.init();
    if (!event.isExist) return undefined;
    return {
        name: event.eventName,
        event: {
            eventId: event.eventId,
            liveRewards: event.liveRewards.map(r => ({
                scoreRank: r.scoreRank,
                points: r.points,
                items: r.items.map(i => ({ name: i.name, count: i.count }))
            }))
        }
    };
}

/** 当前进行中的活动的报酬表；没有活动返回 undefined */
async function currentEventContext(server: Server): Promise<{ event: OptimizeEvent; name: string } | undefined> {
    const current = await resolveCurrentEvent(server);
    if (current.eventId === undefined) return undefined;
    return eventContextById(server, current.eventId);
}

export async function commandDeckBuilder(query: DeckQuery): Promise<Array<Buffer | string>> {
    const target = await resolvePlayerTarget(query);
    if (target.status === 'error') return [target.message];
    if (!webPlatformConfigured()) {
        return ['错误: 未对接网页平台（组卡需要网页账号包数据；在 bot 配置 WEB_PLATFORM_TOKEN 后可用）'];
    }

    // ---- 账号包（卡片/道具按公开开关；隐藏即不可用） ----
    let account;
    try {
        account = (await lookupAccount(target.playerId, target.server)).account;
    } catch (e) {
        if (e instanceof WebPlatformError) {
            if (e.kind === 'not_found') return [`该玩家还没有在网页导入账号包（组卡需要账号包数据）：${target.playerId}`];
            return [`错误: ${e.message}`];
        }
        throw e;
    }
    if (!account.visible.cards || !account.visible.items) {
        return [`该账号没有公开${!account.visible.cards ? '卡片' : ''}${!account.visible.cards && !account.visible.items ? '与' : ''}${!account.visible.items ? '道具' : ''}数据（组卡需要两者可见；可到网页「我的账号」调整公开开关）`];
    }

    let cards: GameAccountCardsData;
    let items: GameAccountItemsData;
    try {
        cards = ((await getAccountData(account.id, 'cards')).data ?? {}) as unknown as GameAccountCardsData;
        items = ((await getAccountData(account.id, 'items')).data ?? {}) as unknown as GameAccountItemsData;
    } catch (e) {
        if (e instanceof WebPlatformError) return [`错误: ${e.message}`];
        throw e;
    }
    if (!Array.isArray(cards.members) || !Array.isArray(items.bandItems)) {
        return ['错误: 账号包数据形状异常（到网页重新导入一次试试）'];
    }

    // ---- 谱面效率（bot 自己的模型；降级数据没有技能权重，出不了正确的收益，直接拒绝） ----
    const musicData = await getMusicData();
    if (!musicData) return ['错误: 谱面效率数据暂不可用, 请稍后再试'];
    if (musicData.degraded) {
        return ['错误: 谱面效率数据当前是备用源的降级数据（缺技能权重），组卡的效率/收益算不准，暂不可用'];
    }
    const charts = toCharts(musicData);

    // ---- master bundle（与网页组卡器同一份查表数据） ----
    const bundle = await getMasterBundle(target.server) as MasterBundle | undefined;
    if (!bundle) return ['错误: 组卡查表数据（master bundle）暂不可用 —— 网页平台可能没在运行，稍后再试'];

    // ---- 模式 ----
    const modeRaw = String(query.mode ?? 'auto').toLowerCase();
    let mode = modeRaw === 'normal' || modeRaw === 'event' || modeRaw === 'auto' ? modeRaw : 'auto';
    let event: OptimizeEvent | undefined;
    let eventName: string | undefined;

    // 显式指定活动 ID → 强制活动模式(往期/未开始的活动也能用: 报酬表来自主数据)
    const explicitEventId = Number(query.eventId ?? query.id);
    if (Number.isFinite(explicitEventId) && explicitEventId > 0) {
        const ctx = await eventContextById(target.server, explicitEventId).catch(() => undefined);
        if (!ctx) return [`错误: 该活动不存在（或未被该服收录）：${explicitEventId}`];
        mode = 'event';
        event = ctx.event;
        eventName = ctx.name;
    } else if (mode !== 'normal') {
        const ctx = await currentEventContext(target.server).catch(() => undefined);
        event = ctx?.event;
        eventName = ctx?.name;
        if (mode === 'event' && !event) {
            return ['错误: 当前没有进行中的活动（活动模式需要报酬表；可带 eventId 指定某期活动，或用 mode=normal 出最高综合力队伍）'];
        }
    }

    // ---- 计算（与网页同算法） ----
    const result: OptimizeResult = optimize({
        bundle,
        cards,
        items,
        charts,
        ...(event ? { event } : {}),
        precision: 'full',
        tgwCardRank: account.tgwCardRank
    });

    // 曲目本体(标题/封面)按「所选服 → 港澳台 → 日服」解析(效率曲 + 收益组合都要)
    const songs = new Map<number, Song>();
    const musicIds = [...new Set([...result.songs.map(g => g.musicId), ...result.combos.map(c => c.group.musicId)])];
    for (const musicId of musicIds) {
        const song = withServer(new Song(musicId), await firstOwner(musicId, target.server));
        await song.init();
        if (song.isExist) songs.set(musicId, song);
    }

    return [await drawDeckBuilder(target.server, {
        playerId: target.playerId,
        title: account.label || account.playerName || target.playerId,
        tgwCardRank: account.tgwCardRank,
        eventName,
        songs,
        result
    }, query.compress ?? false)];
}
