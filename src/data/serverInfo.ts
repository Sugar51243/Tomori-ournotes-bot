import { Server } from '../types/Server';
import { storeFor } from './region';
import { formatGameDateUTC8 } from '../types/Gacha';
import { rarityNames } from '../types/Card';
import { CardKind } from '../search';

/**
 * 多服信息层: 同一个实体在各区域的差异, 直接读各区域的 master 原始行, **不经过领域模型**。
 *
 * 这是「单图多服、每服一行」的数据来源。领域模型仍然只按 id 构造并渲染该实体自身,
 * 区域差异全部由这里汇聚成 ServerRow 交给视图排版。
 *
 * **取数优先级: 该服自己有就用自己的, 没有才回退港澳台服。**
 * 例: 查一首歌时先看各服是否有这条数据 —— 韩服有就用韩服自己的数值显示那一行,
 * 没有才借港澳台的数据顶上; 港澳台自己也没有(例如日服独有曲)时才显示「未收录」。
 *
 * 港澳台/韩/国际三服在上游目前是同一份内容, 所以三行看起来仍然一致;
 * 但规则是按「各服优先」而不是「一律取港澳台」, 区域分叉后行为自然正确。
 */

export interface ServerRow {
    server: Server;
    /** 该服**自己**有这条数据(只有它为真时才能拿这个服去渲染主体) */
    hasOwn: boolean;
    /** 有可展示的数据(自己的或借自港澳台的) */
    exists: boolean;
    cells: Array<[string, string]>;
    /** 数据实际取自哪个区域(与 server 不同 = 借用了港澳台) */
    source: Server;
}

/**
 * 读取某一行应展示的数据: **优先该服自己的, 没有才回退港澳台**。
 * 港澳台自己没有时无处可借(tw 就是兜底源), 该行显示「未收录」。
 */
async function unified<T>(server: Server, fetch: (s: Server) => Promise<T | undefined>): Promise<{ row?: T; source: Server; hasOwn: boolean }> {
    const own = await fetch(server);
    if (own) return { row: own, source: server, hasOwn: true };
    if (server !== 'tw') {
        const tw = await fetch('tw');
        if (tw) return { row: tw, source: 'tw', hasOwn: false };
    }
    return { source: server, hasOwn: false };
}

/** 由 unified 的结果组装一行 */
function toRow(server: Server, r: { row?: CellData; source: Server; hasOwn: boolean }): ServerRow {
    return { server, hasOwn: r.hasOwn, exists: !!r.row, source: r.source, cells: r.row?.cells ?? [] };
}

const DIFF_NAMES = ['EZ', 'NM', 'HD', 'EX'];

/** 定数 · 物量(该难度缺失时为 '-') */
function difficultyCells(
    scoreByChartId: Map<number, { musicScoreDisplayLevel?: number; musicScoreLevel?: number; fullComboCount?: number }>,
    chartIds: number[]
): Array<[string, string]> {
    return DIFF_NAMES.map((label, i) => {
        const score = scoreByChartId.get(chartIds[i] ?? -1);
        if (!score) return [label, '-'] as [string, string];
        const level = score.musicScoreDisplayLevel || score.musicScoreLevel || 0;
        const notes = score.fullComboCount ?? 0;
        return [label, notes ? `${level} · ${notes}` : String(level)] as [string, string];
    });
}

type CellData = { cells: Array<[string, string]> };

async function loadSong(server: Server, songId: number): Promise<CellData | undefined> {
    const store = storeFor(server);
    const song = await store.songById(songId).catch(() => undefined);
    if (!song) return undefined;
    const scores = await store.songScores().catch(() => []);
    const byChartId = new Map(scores.map(s => [s.id, s]));
    return {
        cells: [
            ...difficultyCells(byChartId, [song.easyID, song.normalID, song.hardID, song.expertID]),
            ['上架', formatGameDateUTC8(String(song.startAt ?? ''), server)]
        ]
    };
}

/** 歌曲在各服的定数/物量/上架时间 —— 即「出分」信息(全部来自 master, 无额外上游请求) */
export async function songServerRows(songId: number, servers: Server[]): Promise<ServerRow[]> {
    const rows: ServerRow[] = [];
    for (const server of servers) {
        // 注: 上架时间随区域时区变化, 故若数据借自港澳台, 时间标签也用港澳台的时区
        rows.push(toRow(server, await unified(server, s => loadSong(s, songId))));
    }
    return rows;
}

async function loadCard(server: Server, cardId: number, kind: Exclude<CardKind, 'auto'>): Promise<CellData | undefined> {
    const store = storeFor(server);
    if (kind === 'support') {
        const card = await store.supportCardById(cardId).catch(() => undefined);
        if (!card) return undefined;
        return {
            cells: [
                ['稀有度', rarityNames[card.rarity] ?? `${card.rarity}★`],
                ['类型', '留影'],
                ['实装', formatGameDateUTC8(String(card.startAt ?? ''), server)],
                // 留影的三围是百分比口径(主数据值 ÷100), 与卡片详情页保持一致
                ['综合力', `${((Number(card.performancePowerMax ?? 0) + Number(card.technicPowerMax ?? 0) + Number(card.visualPowerMax ?? 0)) / 100).toFixed(2)}%`]
            ]
        };
    }
    const card = await store.cardById(cardId).catch(() => undefined);
    if (!card) return undefined;
    return {
        cells: [
            ['稀有度', rarityNames[card.rarity] ?? `${card.rarity}★`],
            ['类型', '角色卡'],
            ['实装', formatGameDateUTC8(String(card.startAt ?? ''), server)],
            ['综合力', String(card.performancePowerMax + card.technicPowerMax + card.visualPowerMax)]
        ]
    };
}

/** 卡片在各服的稀有度/实装时间 */
export async function cardServerRows(cardId: number, kind: Exclude<CardKind, 'auto'>, servers: Server[]): Promise<ServerRow[]> {
    const rows: ServerRow[] = [];
    for (const server of servers) {
        rows.push(toRow(server, await unified(server, s => loadCard(s, cardId, kind))));
    }
    return rows;
}

async function loadCharacter(server: Server, characterId: number): Promise<CellData | undefined> {
    const store = storeFor(server);
    const character = await store.characterById(characterId).catch(() => undefined);
    if (!character) return undefined;
    const band = character.bandID ? await store.bandById(character.bandID).catch(() => undefined) : undefined;
    const bandName = band ? await store.text.t(band.nameTextID) : '';
    // 上游的声优文本自带 "CV. " 前缀, 这里剥掉再配自己的标签, 否则会显示成 "CV. CV. xxx"
    const voiceActor = (await store.text.t(String(character.voiceActorTextId ?? '')))
        .replace(/^CV\s*[.．。:：]?\s*/i, '');
    return {
        cells: [
            ['乐队', bandName || '-'],
            ['生日', character.birthdayMonth ? `${character.birthdayMonth}/${character.birthdayDay}` : '-'],
            ['CV', voiceActor || '-']
        ]
    };
}

/** 角色在各服的乐队/生日 */
export async function characterServerRows(characterId: number, servers: Server[]): Promise<ServerRow[]> {
    const rows: ServerRow[] = [];
    for (const server of servers) {
        rows.push(toRow(server, await unified(server, s => loadCharacter(s, characterId))));
    }
    return rows;
}

async function loadEvent(server: Server, eventId: number): Promise<CellData | undefined> {
    const event = await storeFor(server).eventById(eventId).catch(() => undefined);
    if (!event) return undefined;
    return {
        cells: [
            ['开始', formatGameDateUTC8(String(event.startAt ?? ''), server)],
            ['结束', formatGameDateUTC8(String(event.endAt ?? ''), server)]
        ]
    };
}

/** 活动在各服的起止时间 */
export async function eventServerRows(eventId: number, servers: Server[]): Promise<ServerRow[]> {
    const rows: ServerRow[] = [];
    for (const server of servers) {
        rows.push(toRow(server, await unified(server, s => loadEvent(s, eventId))));
    }
    return rows;
}

/** 卡片跨服查询时, 先按「角色卡 -> 支援卡」的既有顺序找第一个存在的服 */
export async function firstServerHavingCard(
    cardId: number,
    kind: Exclude<CardKind, 'auto'>,
    servers: Server[]
): Promise<Server | undefined> {
    for (const server of servers) {
        const store = storeFor(server);
        const hit = kind === 'support'
            ? await store.supportCardById(cardId).catch(() => undefined)
            : await store.cardById(cardId).catch(() => undefined);
        if (hit) return server;
    }
    return undefined;
}
