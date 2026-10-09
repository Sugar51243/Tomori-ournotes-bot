import { AppError } from '../http/errors';
import { reqStr, optStr, optRawStr, rawStr, reqInt, optInt, reqEnum } from '../http/validate';
import { CHART_SORTS, type ChartSort } from '../constants';
import type { OpTable } from './opRouter';
import * as repo from '../db/repos/charts';

/** 自制谱模块(SQL 原样搬自 web 的 chartRepo)。 */

/** 可空字符串字段: 缺省 = 不改; null / '' = 置 NULL */
function nullableStr(p: Record<string, unknown>, field: string, max: number): string | null | undefined {
    const raw = p[field];
    if (raw === undefined || raw === null || raw === '') return raw === undefined ? undefined : null;
    if (typeof raw !== 'string') throw AppError.validation(`${field} 必须是文本或 null`);
    if (raw.length > max) throw AppError.validation(`${field} 最多 ${max} 个字符`);
    return raw;
}

/** 可空整数字段 */
function nullableInt(p: Record<string, unknown>, field: string, opts: { min?: number } = {}): number | null | undefined {
    const raw = p[field];
    if (raw === undefined || raw === null || raw === '') return raw === undefined ? undefined : null;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isInteger(n) || (opts.min !== undefined && n < opts.min)) {
        throw AppError.validation(`${field} 必须是整数或 null`);
    }
    return n;
}

export const chartsOps: OpTable = {
    listPublished: async p => repo.listPublished({
        like: optRawStr(p, 'like', { max: 128 }),
        difficulty: optStr(p, 'difficulty', { max: 16 }),
        musicId: optInt(p, 'musicId', { min: 1 }),
        sort: reqEnum<ChartSort>(p, 'sort', CHART_SORTS, { def: 'latest' }),
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
    }),

    listByAuthor: async p => repo.listByAuthor({
        authorId: reqInt(p, 'authorId', { min: 1 }),
        status: p.status === undefined || p.status === null ? undefined : reqEnum(p, 'status', ['draft', 'published'] as const),
        offset: optInt(p, 'offset', { min: 0, def: 0 }) ?? 0,
        limit: reqInt(p, 'limit', { min: 1, max: 100 }),
    }),

    getRow: async p => repo.getRow(reqInt(p, 'id', { min: 1 })) ?? null,

    getDetail: async p => repo.getDetail(reqInt(p, 'id', { min: 1 })) ?? null,

    create: async p => {
        const id = await repo.create({
            authorId: reqInt(p, 'authorId', { min: 1 }),
            musicId: reqInt(p, 'musicId', { min: 1 }),
            difficulty: reqStr(p, 'difficulty', { max: 16 }),
            title: rawStr(p, 'title', { max: 120 }),
            songTitle: optRawStr(p, 'songTitle', { max: 200 }) ?? '',
            songArtist: optRawStr(p, 'songArtist', { max: 120 }) ?? '',
            description: nullableStr(p, 'description', 65535) ?? null,
            chartData: rawStr(p, 'chartData'),
            noteCount: optInt(p, 'noteCount', { min: 0, def: 0 }) ?? 0,
            origin: reqEnum(p, 'origin', ['official', 'standalone'] as const, { def: 'official' }),
            audioKind: reqEnum(p, 'audioKind', ['upstream', 'upload'] as const, { def: 'upstream' }),
            audioFile: nullableStr(p, 'audioFile', 80) ?? null,
            audioDurationMs: nullableInt(p, 'audioDurationMs', { min: 0 }) ?? null,
            audioSampleRate: nullableInt(p, 'audioSampleRate', { min: 0 }) ?? null,
            coverFile: nullableStr(p, 'coverFile', 80) ?? null,
        });
        return { id };
    },

    update: async p => {
        const fields: Parameters<typeof repo.update>[1] = {};
        const title = optRawStr(p, 'title', { max: 120 });
        const songTitle = optRawStr(p, 'songTitle', { max: 200 });
        const songArtist = optRawStr(p, 'songArtist', { max: 120 });
        const description = nullableStr(p, 'description', 65535);
        const chartData = optRawStr(p, 'chartData');
        const noteCount = nullableInt(p, 'noteCount', { min: 0 });
        const audioKind = p.audioKind === undefined ? undefined : reqEnum(p, 'audioKind', ['upstream', 'upload'] as const);
        const audioFile = nullableStr(p, 'audioFile', 80);
        const audioDurationMs = nullableInt(p, 'audioDurationMs', { min: 0 });
        const audioSampleRate = nullableInt(p, 'audioSampleRate', { min: 0 });
        const coverFile = nullableStr(p, 'coverFile', 80);
        if (title !== undefined) fields.title = title;
        if (songTitle !== undefined) fields.songTitle = songTitle;
        if (songArtist !== undefined) fields.songArtist = songArtist;
        if (description !== undefined) fields.description = description;
        if (chartData !== undefined) fields.chartData = chartData;
        if (noteCount !== undefined && noteCount !== null) fields.noteCount = noteCount;
        if (audioKind !== undefined) fields.audioKind = audioKind;
        if (audioFile !== undefined) fields.audioFile = audioFile;
        if (audioDurationMs !== undefined) fields.audioDurationMs = audioDurationMs;
        if (audioSampleRate !== undefined) fields.audioSampleRate = audioSampleRate;
        if (coverFile !== undefined) fields.coverFile = coverFile;
        await repo.update(reqInt(p, 'id', { min: 1 }), fields);
        return { ok: true };
    },

    softDelete: async p => ({ deleted: await repo.softDelete(reqInt(p, 'id', { min: 1 })) }),

    setStatus: async p => {
        await repo.setStatus(reqInt(p, 'id', { min: 1 }), reqEnum(p, 'status', ['draft', 'published'] as const));
        return { ok: true };
    },

    publishWithPost: async p => repo.publishWithPost({
        id: reqInt(p, 'id', { min: 1 }),
        authorId: reqInt(p, 'authorId', { min: 1 }),
        boardId: reqInt(p, 'boardId', { min: 1 }),
        title: rawStr(p, 'title', { max: 120 }),
        content: rawStr(p, 'content'),
    }),

    syncPostContent: async p => {
        await repo.syncPostContent(reqInt(p, 'postId', { min: 1 }), {
            title: rawStr(p, 'title', { max: 120 }),
            content: rawStr(p, 'content'),
        });
        return { ok: true };
    },

    listReferencedAudioFiles: async () => repo.listReferencedAudioFiles(),
    listReferencedCoverFiles: async () => repo.listReferencedCoverFiles(),
};
