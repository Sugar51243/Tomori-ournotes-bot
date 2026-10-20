import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import { Event, EventLiveRewardRow } from '../../../features/types/Event';
import { Server, serverProfile } from '../../../features/types/Server';
import { Song } from '../../../features/types/Song';
import { RecommendRow, MusicDataScoreRank } from '../../../features/types/MusicData';
import { OVERHEAD_MS, DEFAULT_SKILL_PERCENT, RECOMMEND_DIFFICULTIES } from '../../../upstream/adapter';
import { imageBuffer, jacketUrl } from '../../../upstream/adapter';
import { drawTitle, drawMetaBand, drawSectionBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../../component/list';
import { drawBackground } from '../../component/background';
import { drawServerIcon } from '../../component/serverIcon';
import { fillTextCentered, formatTime, cleanText } from '../../component/draw';
import { cjkFontFamily } from '../../component/fonts';

/**
 * 活动推荐曲图(**一张图三截**: 击奏live / 自由live / 挑战live)。
 *
 * 每个场景按目标评级分段, 段内是所需综合力最低的前若干张谱面(只收 HD/EX 两档难度)。
 * 每行: 封面 + ID + 曲名 + 乐团 | 所需综合力 | 等级 | 难度 | 时长 | BPM | Notes | 局/小时
 *       | 报酬 pt/时 + 道具/时。
 *
 * **报酬列按场景取表**: 击奏/自由 只算「演出报酬」, 挑战live 只算「挑战演出报酬」,
 * 两边不混算(需求指定)。缺谱面模拟数据的行(借自 masterdata + 谱面站的)在对应列显示「—」。
 */

const WIDTH = 980;
const MARGIN = 12;
/**
 * 行高必须装得下「封面 + 两行文字」: 行底色只有 ROW_H - 4 高, 封面与 ID/乐团行一旦超出
 * 就会画到行框外面去(实测 32px 行 + 40px 封面时, 封面上下各溢出 6px、乐团行压到框底之下)。
 */
const ROW_H = 40;
const JACKET = 34;
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const SECTION_TOP = 26 + 6;
const TABLE_HEAD_H = 22;
const SECTION_BOTTOM = 10;
const FOOTER_H = 20;

const DIFF_LABELS: Record<string, string> = { easy: 'EZ', normal: 'NM', hard: 'HD', expert: 'EX' };

/** 各列的右边缘: 从画布右边往左按「列宽 + 间距」排, 与场景无关(三截列数相同) */
interface Columns {
    need: number; level: number; diff: number; time: number; bpm: number; notes: number; perHour: number; pt: number; item: number;
    /** 曲目块(封面 + 文字)的右缘 */
    leftEnd: number;
}
const COLUMNS: Columns = (() => {
    let right = WIDTH - MARGIN;
    const take = (w: number) => { const at = right; right -= w + 6; return at; };
    const item = take(76), pt = take(62), perHour = take(58), notes = take(52), bpm = take(44);
    const time = take(48), diff = take(46), level = take(40), need = take(92);
    return { need, level, diff, time, bpm, notes, perHour, pt, item, leftEnd: need - 98 };
})();

function sectionHeight(rows: number): number {
    return SECTION_TOP + TABLE_HEAD_H + Math.max(rows, 1) * ROW_H + SECTION_BOTTOM;
}

/** 千分位(需求里的数值都比较大) */
function score(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

/** 每小时数值: 小数量级保留 1 位小数 */
function perHourText(v: number): string {
    return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

/** 缺数据的列统一显示「—」 */
function dash(v: string | undefined): string {
    return v ?? '—';
}

/** 该评级的报酬行(取不到返回 undefined) */
function rewardOf(rewards: EventLiveRewardRow[], rank: MusicDataScoreRank['rank']): EventLiveRewardRow | undefined {
    const idx = ['-', '-', 'D', 'C', 'B', 'A', 'S', 'SS'].indexOf(rank);
    return rewards.find(r => r.scoreRank === idx);
}

/** 道具合计(该评级每局) */
function itemsPerPlay(row: EventLiveRewardRow | undefined): number {
    return row ? row.items.reduce((a, b) => a + b.count, 0) : 0;
}

async function drawRow(ctx: SKRSContext2D, song: Song | undefined, row: RecommendRow, rank: number, y: number, reward: EventLiveRewardRow | undefined): Promise<void> {
    ctx.fillStyle = rank <= 3 ? 'rgba(255,255,255,0.08)' : (rank % 2 ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.15)');
    ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, ROW_H - 4);
    const midY = y + (ROW_H - 4) / 2;
    ctx.textBaseline = 'middle';

    // 封面
    const jx = MARGIN + 4;
    ctx.fillStyle = '#222';
    ctx.fillRect(jx, y + (ROW_H - 4 - JACKET) / 2, JACKET, JACKET);
    if (song?.row?.jacketAssetName) {
        const name = String(song.row.jacketAssetName);
        const cover = await imageBuffer(jacketUrl(song.server, name), `images/jacket/${song.server}/${name}.webp`);
        if (cover) {
            try { ctx.drawImage(await loadImage(cover), jx, y + (ROW_H - 4 - JACKET) / 2, JACKET, JACKET); } catch { /* 占位 */ }
        }
    }

    // 曲目块
    const tx = jx + JACKET + 8;
    ctx.textAlign = 'left';
    ctx.font = cjkFontFamily(14);
    ctx.fillStyle = '#FFF';
    ctx.fillText(cleanText(song?.musicTitle ?? `#${row.musicId}`), tx, y + 12, COLUMNS.leftEnd - tx - 6);
    // 这一行混着乐队名(可能是中文, 如「梦限大MewType」), 必须走 CJK 字体栈, 裸 Arial 会出豆腐块
    ctx.font = cjkFontFamily(11);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`ID ${row.musicId} · ${song?.bandName || '未知乐团'}`, tx, y + 27, COLUMNS.leftEnd - tx - 6);

    // 数值列(全部右对齐; 缺数据的显示「—」)
    const hourly = row.perHour;
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px "Arial"';
    ctx.fillStyle = '#ffd76e';
    ctx.fillText(dash(row.need !== undefined ? score(row.need) : undefined), COLUMNS.need, midY, 94);
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#FFF';
    ctx.fillText(String(row.displayLevel), COLUMNS.level, midY, 38);
    ctx.fillText(DIFF_LABELS[row.difficulty] ?? row.difficulty, COLUMNS.diff, midY, 46);
    ctx.fillText(row.bgmMs ? formatTime(row.bgmMs) : '—', COLUMNS.time, midY, 46);
    ctx.fillStyle = '#DDD';
    ctx.fillText(row.bpmMain ? String(row.bpmMain) : '—', COLUMNS.bpm, midY, 44);
    ctx.fillText(row.notes ? String(row.notes) : '—', COLUMNS.notes, midY, 52);
    ctx.fillText(hourly !== undefined ? perHourText(hourly) : '—', COLUMNS.perHour, midY, 58);
    // 报酬列: 只算本场景对应的那张表
    ctx.fillStyle = '#8fd0ff';
    ctx.fillText(reward && hourly !== undefined ? score((reward.points ?? 0) * hourly) : '—', COLUMNS.pt, midY, 62);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(reward && hourly !== undefined ? score(itemsPerPlay(reward) * hourly) : '—', COLUMNS.item, midY, 76);
    ctx.textAlign = 'left';
}

async function drawRankSection(
    ctx: SKRSContext2D,
    title: string,
    rows: RecommendRow[],
    songs: Map<number, Song>,
    reward: EventLiveRewardRow | undefined,
    rewardLabel: '演出' | '挑战',
    y: number
): Promise<number> {
    y = drawSectionBand(ctx, WIDTH, y, title, MARGIN);

    // 每列都传 maxWidth(列的可用宽度): 右对齐 + maxWidth 会把标题压在**本列内**, 不会溢到隔壁列
    const cellW = (right: number, prevRight: number) => Math.max(24, right - prevRight - 6);
    const label = rewardLabel;
    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#9aa4b2';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('曲目', MARGIN + 4, y + TABLE_HEAD_H / 2, COLUMNS.leftEnd - MARGIN - 4);
    ctx.textAlign = 'right';
    ctx.fillText('所需综合力', COLUMNS.need, y + TABLE_HEAD_H / 2, cellW(COLUMNS.need, COLUMNS.leftEnd));
    ctx.fillText('等级', COLUMNS.level, y + TABLE_HEAD_H / 2, cellW(COLUMNS.level, COLUMNS.need));
    ctx.fillText('难度', COLUMNS.diff, y + TABLE_HEAD_H / 2, cellW(COLUMNS.diff, COLUMNS.level));
    ctx.fillText('时长', COLUMNS.time, y + TABLE_HEAD_H / 2, cellW(COLUMNS.time, COLUMNS.diff));
    ctx.fillText('BPM', COLUMNS.bpm, y + TABLE_HEAD_H / 2, cellW(COLUMNS.bpm, COLUMNS.time));
    ctx.fillText('Notes', COLUMNS.notes, y + TABLE_HEAD_H / 2, cellW(COLUMNS.notes, COLUMNS.bpm));
    ctx.fillText('局/小时', COLUMNS.perHour, y + TABLE_HEAD_H / 2, cellW(COLUMNS.perHour, COLUMNS.notes));
    ctx.fillStyle = '#8fd0ff';
    ctx.fillText(`${label}pt/时`, COLUMNS.pt, y + TABLE_HEAD_H / 2, cellW(COLUMNS.pt, COLUMNS.perHour));
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`${label}道具/时`, COLUMNS.item, y + TABLE_HEAD_H / 2, cellW(COLUMNS.item, COLUMNS.pt));
    ctx.textAlign = 'left';
    y += TABLE_HEAD_H;

    if (rows.length === 0) {
        ctx.font = cjkFontFamily(13);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('没有满足该评级的谱面', MARGIN + 4, y + ROW_H / 2, COLUMNS.leftEnd - MARGIN - 4);
        return y + ROW_H + SECTION_BOTTOM;
    }

    for (let i = 0; i < rows.length; i++) {
        await drawRow(ctx, songs.get(rows[i].musicId), rows[i], i + 1, y, reward);
        y += ROW_H;
    }
    return y + SECTION_BOTTOM;
}

export interface RecommendSection {
    /** 场景: 击奏live / 自由live / 挑战live(挑战是单独模式, 只能用活动曲) */
    mode: 'battle' | 'free' | 'challenge';
    rank: MusicDataScoreRank['rank'];
    rows: RecommendRow[];
    /** 段标题; 省略时按「场景 · 目标评级 · 所需综合力最低前 N」拼 */
    title?: string;
    /** 报酬列表: 击奏/自由 只算演出报酬, 挑战live 只算挑战演出报酬 */
    reward: 'live' | 'challenge';
}

/** 该场景在界面上的名字 */
function modeLabel(mode: RecommendSection['mode']): string {
    if (mode === 'battle') return '击奏live';
    if (mode === 'free') return '自由live';
    return '挑战live';
}

export async function drawEventRecommend(
    server: Server,
    event: Event,
    sections: RecommendSection[],
    songs: Map<number, Song>,
    compress: boolean,
    topN: number,
    notes: string[] = []
): Promise<Array<Buffer | string>> {
    const height = HEADER_H + MARGIN
        + sections.reduce((sum, s) => sum + sectionHeight(s.rows.length), 0)
        + FOOTER_H * 2 + MARGIN + notes.length * 16;   // 页脚两行: 算法说明 + 数据来源
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    await drawBackground(ctx, WIDTH, height, { server, bandId: event.backgroundBandId() });
    drawTitle(ctx, WIDTH, '活动推荐曲');

    // 副信息带: 国旗 + 服名 + 活动名 + 场景参数
    const metaMidY = drawMetaBand(ctx, WIDTH);
    const profile = serverProfile(server);
    await drawServerIcon(ctx, MARGIN, metaMidY - 8, server, 16);
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#DDD';
    fillTextCentered(ctx, profile.displayName, MARGIN + 28, metaMidY, 160);
    let hx = MARGIN + 28 + ctx.measureText(profile.displayName).width + 14;
    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#FFF';
    fillTextCentered(ctx, `ID ${event.eventId} ${event.eventName}`, hx, metaMidY, 340);
    hx += Math.min(340, ctx.measureText(`ID ${event.eventId} ${event.eventName}`).width) + 14;
    ctx.fillStyle = '#9aa4b2';
    const diffLabels = RECOMMEND_DIFFICULTIES.map(d => DIFF_LABELS[d]).join('/');
    const hint = `击奏 5 人房 / 自由·挑战 单人 · ${diffLabels} · 技能全 ${DEFAULT_SKILL_PERCENT}% · 结算耗时 ${OVERHEAD_MS / 1000}s`;
    fillTextCentered(ctx, hint, hx, metaMidY, WIDTH - MARGIN - hx);

    let y = HEADER_H + MARGIN;
    for (const section of sections) {
        const rank = section.rows[0]?.targetRank ?? section.rank;
        const title = section.title ?? `${modeLabel(section.mode)} · 目标评级 ${rank} · 所需综合力最低前 ${topN}`;
        const rewards = section.reward === 'live' ? event.liveRewards : event.challengeRewards;
        y = await drawRankSection(ctx, title, section.rows, songs, rewardOf(rewards, rank), section.reward === 'live' ? '演出' : '挑战', y);
    }

    ctx.font = cjkFontFamily(12);
    ctx.fillStyle = '#8a93a0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
        `所需综合力 = 该评级门槛 ÷ 分/综合力；pt/时、道具/时 = 本场景报酬 × 局/小时(局/小时 = 3600s ÷ (BGM 时长 + ${OVERHEAD_MS / 1000}s))；击奏/自由只算演出报酬, 挑战live 只算挑战演出报酬`,
        MARGIN, y + FOOTER_H / 2, WIDTH - MARGIN * 2);
    y += FOOTER_H;
    // 推荐曲只在完整 music-data(种子模型)可用时才会出图, 所以来源固定标注为 music-data 主源
    ctx.fillText(
        `数据来源：bdon.moe（music-data.json）+ 活动榜单（上游回退链）`,
        MARGIN, y + FOOTER_H / 2, WIDTH - MARGIN * 2);
    y += FOOTER_H;
    for (const note of notes) {
        ctx.fillText(note, MARGIN, y + 8, WIDTH - MARGIN * 2);
        y += 16;
    }

    return [await outputFinalBuffer(canvas, compress)];
}
