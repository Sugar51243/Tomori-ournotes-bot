import { DataSourceProfile, SourceRole } from '../../config/sources';
import { SourceFetchPlan } from './plan';

/**
 * haneoka.org(BanG Dream! Our Notes 数据库)取数方式的翻译层(纯函数, 不发起请求)。
 *
 * 把「规范化 bdon 布局请求」翻译成该源的取数计划:
 * - 活动/曲榜排行(gameApi): `{base}/api/v1/{server}/...` → `{base}/api/v1/game/records/{region}/...`,
 *   响应形状与 bdon rankd 不同, 由 transform 现场换算(实测两者是**同一份数据**: 前 100 名逐条一致)
 * - 玩家查询(site): `{site}/api/players/{server}/{id}` → `{base}/api/v1/game/records/{region}/players/{id}`,
 *   换算成站点公开接口的形状交由既有 normalize 消费
 * - 乐曲分析(musicData): storage 上的 music-data.json → `{base}/api/v1/servers/intl/song-meta`,
 *   合成 bdon 形状的**降级**数据(站点直接给效率/物量等结果, 没有种子模型 —— 见下)
 *
 * ⚠ 剧透模式: 上游作者声明不可接入超前内容。该站的超前内容是 **-cbt / -test 数据集**
 * (站点由前端的「显示剧透内容」开关决定读不读它们; API 本身不看 cookie)。因此本翻译器
 * **只产生发行数据集请求**: game records 只允许 tw/jp/kr/en, catalog 固定 intl。
 * 任何其它数据集名(如 jp-cbt、intl-test)在这里就返回 undefined, 不会发出请求。
 *
 * 时间戳: bdon 的「上游取数时间」藏在 ETag 里, haneoka 直接给 fetchedAtMs 字段 ——
 * 用 deriveUpstreamAt 声明取法, 链统一带进 FetchedBuffer.upstreamAt(见 ./plan.ts)。
 */

/** 发行服(游戏 records 的真实区域); 其它名字一概不请求(剧透保险) */
const RELEASE_REGIONS: readonly string[] = ['tw', 'jp', 'kr', 'en'];
/** 发行区 catalog 数据集: 港澳台/韩/国际合一的 intl(与 bdon music-data.json 的 tw 起源对齐) */
const RELEASE_CATALOG_SERVER = 'intl';

/** 难度下标 → 难度名(0..3 = easy..expert, 与 songs catalog 的 difficultyName 一致) */
export const DIFFICULTY_BY_INDEX: readonly string[] = ['easy', 'normal', 'hard', 'expert'];

/** 降级数据的 format 标记: 消费方据此识别「没有技能权重/评级门槛」的替代模型 */
export const HANEOKA_MUSIC_DATA_FORMAT = 'haneoka.song-meta/1';

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/** 数字收口: null/空串**不是 0**, 一律判为缺失(Number(null) === 0 会把它悄悄变成 0) */
function num(v: unknown): number | undefined {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string' && !v.trim()) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

/** 上游时间钩子: haneoka 的榜单/活动响应用 fetchedAtMs 直接给「数据是什么时候抓的」 */
export function haneokaUpstreamAt(data: Buffer): number | undefined {
    try {
        const body = JSON.parse(data.toString('utf8')) as { fetchedAtMs?: unknown };
        const ms = num(body?.fetchedAtMs);
        return ms !== undefined && ms > 0 ? ms : undefined;
    } catch {
        return undefined;
    }
}

// ---- 响应换算: haneoka -> bdon rankd 形状 ----

interface HaneokaChallenge {
    id?: unknown;
    musicId?: unknown;
    enabled?: unknown;
    status?: unknown;
}

interface HaneokaEvent {
    id?: unknown;
    startAtMs?: unknown;
    endAtMs?: unknown;
    status?: unknown;
    pointRankingEnabled?: unknown;
    challenges?: HaneokaChallenge[];
}

/**
 * 活动对象 → rankd 形状。
 * `expectedEventId`: 「单活动详情」在 haneoka 没有对应端点, 只能取 /events/current 再校验 id ——
 * 不是同一个活动就**抛错**(视同该源失败), 让链回到 bdon 的按 id 详情。
 */
export function haneokaEventToRankd(data: Buffer, expectedEventId?: string): Buffer {
    const body = JSON.parse(data.toString('utf8')) as { event?: HaneokaEvent };
    const e = body?.event;
    if (!e || e.id === undefined || e.id === null) throw new Error('haneoka: no current event');
    if (expectedEventId !== undefined && String(e.id) !== expectedEventId) {
        throw new Error(`haneoka: current event ${String(e.id)} != requested ${expectedEventId}`);
    }
    const out = {
        eventId: e.id,
        // haneoka 的 current 不含活动种类; bot 侧展示用 masterdata 的 eventType, 这里留空即可
        startAt: num(e.startAtMs),
        endAt: num(e.endAtMs),
        // 阶段词表与 rankd 同族(实测 result; 未知值由 bot 的 parseEventPhase 判为「未知」保守放行)
        eventStatus: typeof e.status === 'string' ? e.status : undefined,
        pointRanking: { enabled: e.pointRankingEnabled === true },
        challengeRankings: (e.challenges ?? []).map(c => ({
            challengeMusicId: c.id,
            musicId: c.musicId,
            rankingEnabled: c.enabled !== false,
            collectStatus: typeof c.status === 'string' ? c.status : undefined
        }))
    };
    return Buffer.from(JSON.stringify(out));
}

interface HaneokaRankingRow {
    playerId?: unknown;
    profileId?: unknown;
    name?: unknown;
    score?: unknown;
    totalPower?: unknown;
    favoriteMemberCardId?: unknown;
}

/** 榜单(曲榜/挑战曲榜) → rankd `{players:[...]}` 形状(名次按数组顺序, 与 bot 的 toEntries 一致) */
export function haneokaRankingToRankd(data: Buffer): Buffer {
    const body = JSON.parse(data.toString('utf8')) as { rows?: HaneokaRankingRow[]; error?: unknown };
    if (body?.error) throw new Error(`haneoka: ranking error body: ${JSON.stringify(body.error)}`);
    const players = (Array.isArray(body?.rows) ? body.rows : []).map(r => ({
        score: num(r.score),
        playerData: {
            id: str(r.playerId ?? r.profileId),
            name: str(r.name),
            favoriteMemberCard: { cardId: num(r.favoriteMemberCardId) }
        },
        highScoreDeck: { totalPower: num(r.totalPower) }
    }));
    return Buffer.from(JSON.stringify({ players }));
}

interface HaneokaProfileCardPage { sourceUrl?: unknown }

/** 玩家档案 → bdon 站点公开接口的形状(既有 normalize 直接消费) */
export function haneokaPlayerToSite(data: Buffer): Buffer {
    const body = JSON.parse(data.toString('utf8')) as {
        profileId?: unknown;
        fetchedAtMs?: unknown;
        profile?: {
            playerId?: unknown;
            name?: unknown;
            level?: unknown;
            rankExp?: unknown;
            totalFavorite?: unknown;
            totalFavoriteExact?: unknown;
            favoriteMemberCardMasterId?: unknown;
            favoriteMemberCard?: { cardId?: unknown };
            profileCard?: { thumbnailUrls?: unknown; pages?: HaneokaProfileCardPage[] };
        };
    };
    const p = body?.profile;
    if (!p || (p.playerId === undefined && p.name === undefined)) throw new Error('haneoka: player profile missing');

    // 头像优先用游戏 CDN 的原始地址(pages[].sourceUrl —— 在外链白名单里, 也不经 bdon 中转);
    // 退化到站点自己的 thumbnailUrls
    const thumbs = (Array.isArray(p.profileCard?.pages) ? p.profileCard.pages : [])
        .map(page => str(page?.sourceUrl)).filter(Boolean);
    if (!thumbs.length && Array.isArray(p.profileCard?.thumbnailUrls)) {
        thumbs.push(...p.profileCard.thumbnailUrls.map(str).filter(Boolean));
    }

    const totalFavorite = num(p.totalFavorite) ?? num(p.totalFavoriteExact);
    const rankExp = num(p.rankExp);
    const out = {
        profile: {
            profileId: str(p.playerId ?? body.profileId),
            name: str(p.name),
            rankExp: rankExp !== undefined ? String(rankExp) : undefined,
            favoriteMemberCard: { cardId: num(p.favoriteMemberCard?.cardId ?? p.favoriteMemberCardMasterId) },
            profileCard: { thumbnailUrl: thumbs }
        },
        brief: { level: num(p.level) },
        favorites: { totalFavorite },
        fetchedAt: num(body.fetchedAtMs)
    };
    return Buffer.from(JSON.stringify(out));
}

// ---- 乐曲分析(降级模型) ----

interface HaneokaChartMeta {
    /** 出分(chart-relative factor, 与 bot 的「分/综合力」同列) */
    score?: unknown;
    /** 效率(分/分钟): 恒等于 score ÷ ((time + 30s) / 60) */
    eff?: unknown;
    /** 物量(满连数) */
    n?: unknown;
    /** 显示等级 */
    displayLevel?: unknown;
    /** 游戏内谱面等级 */
    playLevel?: unknown;
    /** 谱面时长(秒, 取全曲各难度的最大收尾时间) */
    time?: unknown;
    /** 起始 BPM */
    firstBpm?: unknown;
    metaStatus?: unknown;
}

interface HaneokaDifficultyEntry {
    chart?: HaneokaChartMeta;
    /** 击奏live(gekisou)的分析; 没有击奏数据的谱面无此段 */
    gekisou?: { score?: unknown; eff?: unknown; metaStatus?: unknown };
}

/** 结算耗时(秒) —— 与 bot 的效率分母口径一致(upstream/musicData/client.ts 的 OVERHEAD_MS) */
const OVERHEAD_S = 30;

/**
 * 站点「乐曲分析」→ 合成的 music-data 形状(**降级**)。
 *
 * 站点直接给结果(出分 score / 效率 eff / 物量 / 等级 / 时长), bdon 的 music-data.json
 * 给的是种子模型(每张谱面的 base + 各技能槽权重 + 评级门槛)。这里把站点结果**装进同形状**:
 * - `base` ← 站点的 score(chart-relative factor, 与 bot 的「分/综合力」同列);
 *   实测二者口径一致: eff 恒等于 score ÷ ((time + 30s) / 60), 所以 bot 算出的
 *   perMinute(综合力/分钟)会**恰好等于站点自己的 eff**;
 * - 权重/评级门槛无从取得 → 权重留空(技能不影响出分)、scoreRanks 为空 ——
 *   消费方必须按 MusicData.degraded 分流(歌曲meta 照常出榜并注明来源; 推荐曲/组卡器拒绝)。
 *
 * 难度与物量口径已实测核对(songs catalog 的 difficultyName 0..3 = easy..expert;
 * 站点的 eff 分母同样带 30s 结算耗时)。
 */
export function haneokaSongMetaToMusicData(data: Buffer): Buffer {
    const raw = JSON.parse(data.toString('utf8')) as Record<string, Record<string, HaneokaDifficultyEntry>>;
    const songs: unknown[] = [];
    for (const [key, diffs] of Object.entries(raw ?? {})) {
        const musicId = num(key);
        if (musicId === undefined || !diffs || typeof diffs !== 'object') continue;

        // 时长取任一难度的 time(站点的 time 就是「全曲各难度的最大收尾时间」, 各难度同值)
        const timeS = num(diffs['0']?.chart?.time);
        if (timeS === undefined || timeS <= 0) continue;
        const bgmMs = Math.round(timeS * 1000);
        const factor = (bgmMs + OVERHEAD_S * 1000) / 60000;   // eff → score 的反算(score 缺失时的兜底)

        /** 出分优先用 score; 缺失时从 eff 反算; 都没有则按缺失处理 */
        const scoreOf = (s: unknown, eff: unknown): number | undefined => {
            const direct = num(s);
            if (direct !== undefined && direct > 0) return direct;
            const e = num(eff);
            return e !== undefined && e > 0 ? e * factor : undefined;
        };

        const charts: unknown[] = [];
        for (let i = 0; i < DIFFICULTY_BY_INDEX.length; i++) {
            const entry = diffs[String(i)];
            const chart = entry?.chart;
            if (!chart || chart.metaStatus !== 'available') continue;
            const freeScore = scoreOf(chart.score, chart.eff);
            if (freeScore === undefined) continue;
            const battleScore = entry?.gekisou?.metaStatus === 'available'
                ? scoreOf(entry.gekisou.score, entry.gekisou.eff)
                : undefined;
            const seed = (score: number) => [{ score, weights: [] as number[] }];
            charts.push({
                difficulty: DIFFICULTY_BY_INDEX[i],
                // 站点 song-meta 不带 scoreId, 按官方编号规则合成(仅用作排序末位比较)
                scoreId: musicId * 100 + i,
                displayLevel: num(chart.displayLevel) ?? num(chart.playLevel) ?? 0,
                level: num(chart.playLevel),
                notes: { judged: num(chart.n) ?? 0 },
                bpm: { main: num(chart.firstBpm) ?? 0 },
                deck: {
                    unplayable: false,
                    seeds: battleScore !== undefined ? seed(battleScore) : [],
                    offSeeds: seed(freeScore)
                }
            });
        }
        if (charts.length) songs.push({ id: musicId, bgm: { length: { durationMs: bgmMs } }, charts, scoreRanks: [] });
    }
    return Buffer.from(JSON.stringify({ format: HANEOKA_MUSIC_DATA_FORMAT, power: 1, songs }));
}

// ---- URL 翻译 ----

/** 规范化 bdon 布局 URL → haneoka 取数计划; undefined = 该源不参与这个请求 */
export function haneokaFetchPlan(canonicalUrl: string, role: SourceRole, profile: DataSourceProfile): SourceFetchPlan | undefined {
    let u: URL;
    try {
        u = new URL(canonicalUrl);
    } catch {
        return undefined;
    }
    // 规范化 URL 一律不带查询/片段; 带了说明不是认识的形状, 不冒险
    if (u.search || u.hash || !profile.gameApiBase) return undefined;

    if (role === 'musicData') {
        // detectRole 只对 config.musicDataUrl(那一份 music-data.json)判为 musicData 角色
        return {
            url: `${trimSlash(profile.gameApiBase)}/api/v1/servers/${RELEASE_CATALOG_SERVER}/song-meta?projection=4`,
            transform: haneokaSongMetaToMusicData
        };
    }

    const segments = u.pathname.split('/').filter(Boolean);

    if (role === 'gameApi') {
        const [api, v1, region, ...rest] = segments;
        if (api !== 'api' || v1 !== 'v1' || region === undefined || !RELEASE_REGIONS.includes(region)) return undefined;
        const base = `${trimSlash(profile.gameApiBase)}/api/v1/game/records/${region}`;

        if (rest[0] === 'events' && rest[1] === 'current' && rest.length === 2) {
            return { url: `${base}/events/current`, transform: (d: Buffer) => haneokaEventToRankd(d) };
        }
        if (rest[0] === 'events' && /^\d+$/.test(rest[1] ?? '') && rest.length === 2) {
            // 单活动详情: haneoka 只追踪 current —— 取 current 并校验 id, 不匹配即失败回退
            const wanted = rest[1];
            return { url: `${base}/events/current`, transform: (d: Buffer) => haneokaEventToRankd(d, wanted) };
        }
        if (rest[0] === 'events' && /^\d+$/.test(rest[1] ?? '') && rest[2] === 'challenges'
            && /^\d+$/.test(rest[3] ?? '') && rest[4] === 'ranking' && rest.length === 5) {
            return {
                url: `${base}/events/${rest[1]}/challenges/${rest[3]}/ranking`,
                transform: haneokaRankingToRankd,
                deriveUpstreamAt: haneokaUpstreamAt
            };
        }
        if (rest[0] === 'music' && /^\d+$/.test(rest[1] ?? '') && rest[2] === 'ranking' && rest.length === 3) {
            return {
                url: `${base}/songs/${rest[1]}/ranking`,
                transform: haneokaRankingToRankd,
                deriveUpstreamAt: haneokaUpstreamAt
            };
        }
        return undefined;
    }

    if (role === 'site') {
        const [api, players, region, id] = segments;
        if (api !== 'api' || players !== 'players' || region === undefined || !RELEASE_REGIONS.includes(region)) return undefined;
        if (!/^\d{1,19}$/.test(id ?? '')) return undefined;
        return {
            url: `${trimSlash(profile.moenotesSiteBase)}/api/v1/game/records/${region}/players/${id}`,
            transform: haneokaPlayerToSite
        };
    }

    return undefined;
}
