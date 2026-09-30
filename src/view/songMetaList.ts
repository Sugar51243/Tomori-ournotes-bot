import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { Song } from '../types/Song';
import { Server } from '../types/Server';
import { config } from '../config';
import { songServerRows, ServerRow } from '../data/serverInfo';
import { drawTitle, drawMetaBand, outputFinalBuffer, TITLE_BAND_H, META_BAND_H } from '../components/list';
import { drawBackground } from '../components/background';
import { drawMultiServerTable, multiServerTableHeight } from '../components/multiServerTable';
import { cjkFontFamily } from '../components/fonts';
import { fillTextCentered } from '../components/draw';

/**
 * 全歌曲表(tsugu songMeta 对应物)。
 *
 * **每首歌只显示一个服务器的一行**(不再逐服铺开):
 * 数据优先取港澳台服, 港澳台没有该曲时改取日服 —— 行首国旗标明这一行取自哪个服。
 * 行内是该服的 EZ/NM/HD/EX 定数与物量(即出分信息)以及上架时间, 全部为静态 master 数据。
 *
 * 85 首 × 每首一行仍然很长, 故按 SONGS_PER_PAGE 分页, 每页一张图。
 */

const WIDTH = 900;
const MARGIN = 16;
/** 页头 = 主标题带 + 副信息带(说明文字), 两者都是纯色底 */
const HEADER_H = TITLE_BAND_H + META_BAND_H;
const SONG_HEAD_H = 28;
const SONG_GAP = 6;

/** 单首歌区块的高度: 区块头 + 一行数据(列头只在页首画一次) */
function songBlockHeight(): number {
    return SONG_HEAD_H + multiServerTableHeight(1, false) + SONG_GAP;
}

/** 区块头: 曲目 ID / 标题 / 乐队 / 分类 / 时长 */
function drawSongHeader(ctx: SKRSContext2D, y: number, song: Song): void {
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(24, 26, 44, 0.72)';
    ctx.fillRect(MARGIN, y, WIDTH - MARGIN * 2, SONG_HEAD_H - 4);

    ctx.font = cjkFontFamily(15);
    ctx.fillStyle = '#FFF';
    ctx.fillText(song.musicTitle, MARGIN + 8, y + (SONG_HEAD_H - 4) / 2, 420);

    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#BBB';
    ctx.fillText(String(song.songId), MARGIN + 436, y + (SONG_HEAD_H - 4) / 2, 70);

    ctx.font = cjkFontFamily(13);
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(song.bandName, MARGIN + 508, y + (SONG_HEAD_H - 4) / 2, 150);
    if (song.categories.length) {
        ctx.fillText(song.categories.join('/'), MARGIN + 662, y + (SONG_HEAD_H - 4) / 2, WIDTH - MARGIN - 732);
    }
    // 时长取自全区共享的谱面站点, 与区域无关, 故放在区块头
    const duration = song.durationMs
        ? `${Math.floor(song.durationMs / 60000)}:${String(Math.round(song.durationMs / 1000) % 60).padStart(2, '0')}`
        : '-';
    ctx.font = '13px "Arial"';
    ctx.fillStyle = '#BBB';
    ctx.textAlign = 'right';
    ctx.fillText(duration, WIDTH - MARGIN - 8, y + (SONG_HEAD_H - 4) / 2, 54);
    ctx.textAlign = 'left';
}

/**
 * 出分表每曲只显示一行, 选哪一行: 港澳台 -> 日服 -> 其它(都要求该服**自己有**该曲数据),
 * 全都没有时才退而取任意一行(可能是借来的数据)。
 */
function pickRow(rows: ServerRow[]): ServerRow | undefined {
    return rows.find(r => r.server === 'tw' && r.hasOwn)
        ?? rows.find(r => r.server === 'jp' && r.hasOwn)
        ?? rows.find(r => r.hasOwn)
        ?? rows.find(r => r.exists);
}

export async function drawSongMetaList(songs: Song[], servers: Server[], compress: boolean): Promise<Array<Buffer | string>> {
    const songsPerPage = Math.max(1, config.songsPerPage);
    const pages: Song[][] = [];
    for (let i = 0; i < songs.length; i += songsPerPage) {
        pages.push(songs.slice(i, i + songsPerPage));
    }
    if (pages.length === 0) {
        return ['错误: 没有可显示的歌曲'];
    }

    const blockH = songBlockHeight();
    const buffers: Buffer[] = [];
    for (let p = 0; p < pages.length; p++) {
        const page = pages[p];

        // 先把这一页每一首的取数行算出来: 列头取自第一条可用行, 保证列宽对齐
        const pageRows = await Promise.all(page.map(song => songServerRows(song.songId, servers).then(pickRow)));
        const labels = pageRows.find(r => r && r.cells.length)?.cells.map(([label]) => label) ?? [];

        const headerH = labels.length ? multiServerTableHeight(1) : 0;
        const height = HEADER_H + MARGIN + headerH + page.length * blockH + MARGIN;
        const canvas = createCanvas(WIDTH, height);
        const ctx = canvas.getContext('2d');

        await drawBackground(ctx, WIDTH, height, { server: servers[0] });
        const pageLabel = pages.length > 1 ? `（第 ${p + 1}/${pages.length} 页）` : '';
        drawTitle(ctx, WIDTH, `全歌曲列表 (${songs.length})${pageLabel}`);

        // 取数规则画在副信息带的正中间: 半截压在背景图上的话既不像标题栏, 也会显得没对齐
        const metaMidY = drawMetaBand(ctx, WIDTH);
        ctx.font = cjkFontFamily(12);
        ctx.fillStyle = '#9aa4b2';
        fillTextCentered(ctx, '每曲一行 · 优先港澳台服, 无则改取日服', MARGIN, metaMidY, WIDTH - MARGIN * 2);

        // 列头只在页首画一次
        let y = HEADER_H + MARGIN;
        if (labels.length) {
            y = await drawMultiServerTable(ctx, MARGIN, y, WIDTH - MARGIN * 2, [], { headerOnly: true, labels });
        }

        for (let i = 0; i < page.length; i++) {
            drawSongHeader(ctx, y, page[i]);
            const row = pageRows[i];
            if (row) {
                await drawMultiServerTable(ctx, MARGIN, y + SONG_HEAD_H, WIDTH - MARGIN * 2, [row], { showHeader: false });
            }
            y += blockH;
        }

        buffers.push(await outputFinalBuffer(canvas, compress));
    }
    return buffers;
}
