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
import { challengeSongIds } from '../event/challengeSongs';
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
 * - 谱面效率与活动报酬: bot 自己（与 /songMeta、/eventDeckContext 同一份模型）;
 * - 活动挑战曲池: 与 /eventRecommend 共用 features/event/challengeSongs.ts 的同一份口径。
 *
 * 模式: normal（最高综合力 + 效率曲）/ event（活动收益最大化：自由live 两组榜 + 挑战live 一组榜）/
 * auto（有进行中活动则用活动模式）。
 *
 * 技能基准: bot 固定**方案3**（基准取序，各槽默认 +60%）。网页组卡器可选方案0~4（按精准度编号，
 * 0 最准：全曲+实际基准；其余方案的全量档按各卡 live 技能的实际比率算），
 * 见 web 侧 deck.ts 的 SkillBaseline / baselineForScheme。
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

/**
 * bot 的歌曲meta 数据 → 组卡算法要的谱面效率行（口径与网页的 /chartEfficiency 应当完全一致；
 * scripts/compare-web-inputs.ts 就拿它跟端点那份逐行比对）。
 */
export function toCharts(data: NonNullable<Awaited<ReturnType<typeof getMusicData>>>): ChartEfficiency[] {
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

/**
 * 该活动的收益上下文（optimize 的活动模式用）；没收录返回 undefined。
 *
 * 三样都要给全：自由live 的演出报酬、挑战live 的挑战演出报酬、以及活动加成乐队与挑战曲池。
 * 挑战曲池与 /eventRecommend 共用同一份口径（见 features/event/challengeSongs.ts）。
 */
async function eventContextById(server: Server, eventId: number): Promise<{ event: OptimizeEvent; name: string } | undefined> {
    const event = withServer(new Event(eventId), server);
    await event.init();
    if (!event.isExist) return undefined;
    const toRows = (rows: Event['liveRewards']) =>
        rows.map(r => ({
            scoreRank: r.scoreRank,
            points: r.points,
            items: r.items.map(i => ({ name: i.name, count: i.count }))
        }));
    return {
        name: event.eventName,
        event: {
            eventId: event.eventId,
            liveRewards: toRows(event.liveRewards),
            challengeRewards: toRows(event.challengeRewards),
            bonusBandIds: event.bonusBandIds,
            challengeMusicIds: await challengeSongIds(server, eventId).catch(() => [])
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
    // 卡库**必须有**：没有卡就没有队伍，算不了，只能报错
    if (!account.visible.cards) {
        return ['该账号没有公开卡片数据（组卡必须有卡库；可到网页「我的账号」打开卡片的公开开关）'];
    }

    let cards: GameAccountCardsData;
    try {
        cards = ((await getAccountData(account.id, 'cards')).data ?? {}) as unknown as GameAccountCardsData;
    } catch (e) {
        if (e instanceof WebPlatformError) return [`错误: ${e.message}`];
        throw e;
    }
    if (!Array.isArray(cards.members)) {
        return ['错误: 账号包数据形状异常（到网页重新导入一次试试）'];
    }

    // 道具**没有也能算**：没公开 / 取不到 / 形状不对，一律按"全部未解锁"继续，
    // 只把「乐队道具加成」这一块记 0（bandItemRates 对空表就是全 0，不是没算）。
    // 少了这块综合力会偏低，所以**图上必须注明**，免得用户以为数字是对的。
    // 早先这里是「卡片与道具缺一不可」，于是把道具设成私密的人根本用不了组卡。
    let bandItems: Array<[number, number]> = [];
    let noItemBonus = false;
    if (account.visible.items) {
        try {
            const items = ((await getAccountData(account.id, 'items')).data ?? {}) as unknown as GameAccountItemsData;
            if (Array.isArray(items.bandItems)) bandItems = items.bandItems;
            else noItemBonus = true;
        } catch {
            noItemBonus = true;
        }
    } else {
        noItemBonus = true;
    }
    const items: GameAccountItemsData = { items: [], bandItems };

    // TGW CARD 等级同样取不到就按 1（= 无加成）算，不拦
    const tgwCardRank = Number.isFinite(account.tgwCardRank) && (account.tgwCardRank as number) > 0 ? (account.tgwCardRank as number) : 1;

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
        // bot 固定方案3（基准取序·可自定义；默认五槽 +60%）。网页端可选方案0~4，见 web 组卡器
        scheme: 3,
        tgwCardRank
    });

    // 没拿到道具就少了一块加成，必须写在图上 —— 否则综合力偏低会被当成算错了
    if (noItemBonus) {
        result.notes.unshift('没有取到该账号的公开道具数据，本次按未解锁处理、不计乐队道具加成（综合力会偏低）。');
    }

    // 曲目本体(标题/封面)按「所选服 → 港澳台 → 日服」解析(效率曲 + 各组收益榜都要)
    const songs = new Map<number, Song>();
    const musicIds = [
        ...new Set([
            ...result.songs.map(g => g.musicId),
            ...(result.boards ?? []).flatMap(b => b.tables.flatMap(t => t.rows.map(r => r.musicId)))
        ])
    ];
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
