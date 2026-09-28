import {
    NnNotesChart, NnNote, NnBpmChange, CanonicalChart, CanonicalNote, CanonicalNoteType,
    SlideChain, SlideNode, TracePoint, FeverSegment, BpmSegment
} from '../types/Chart';
import { estimateBpmSegments } from './bpm';

export class UnsupportedFormatError extends Error { }

/**
 * nnnotes.live-score/1 -> CanonicalChart
 * 分类以 opName 为准(judgementType 仅作交叉校验); 滑条链沿 lineIds 组装,
 * Combo(trace)点按 lineBeginId/lineEndId 配对成弯曲路径; fever 1 开 2 闭。
 * 所有对官方格式的假设集中在此文件。
 */

const OP_CLASSIFY: Record<string, CanonicalNoteType> = {
    Normal: 'Tap',
    Flick: 'Flick',
    SlideBegin: 'SlideBegin',
    SlideBeginFlick: 'SlideBeginFlick',
    SlideConnection: 'SlideConnect',
    SlideEnd: 'SlideEnd',
    SlideEndFlick: 'SlideEndFlick',
    // Combo 计入连击但不可见(官方渲染类型为 None), 保留在判定音符中供计数
    Combo: 'Combo'
};

/** 官方 Trace 类 op(60-63/104/105): 可见的轨迹点 */
const TRACE_OPS = new Set([60, 61, 62, 63, 104, 105]);

function toCanonicalNote(n: NnNote, type: CanonicalNoteType): CanonicalNote {
    return {
        id: n.id,
        type,
        timeMs: n.timeMs,
        tick: n.tick,
        bar: n.bar,
        rhythm: n.rhythm,
        laneStart: n.laneStart,
        laneEnd: n.laneEnd,
        laneStartFloat: n.laneStartFloat,
        laneEndFloat: n.laneEndFloat,
        width: n.width,
        critical: !!n.critical,
        direction: n.direction === 'Left' || n.direction === 'Right' ? n.direction : undefined,
        fever: n.fever ?? null,
        pairNoteId: n.pairNoteId && n.pairNoteId !== 0 ? n.pairNoteId : undefined,
        judgementType: n.judgementType,
        visible: n.visible !== false
    };
}

function isSlideNote(n: NnNote): boolean {
    return n.opName === 'SlideBegin' || n.opName === 'SlideConnection' || n.opName === 'SlideEnd' || n.opName === 'SlideEndFlick';
}

function toSlideNode(n: NnNote): SlideNode {
    const kind = n.opName === 'SlideBegin' || n.opName === 'SlideBeginFlick' ? 'Begin' as const
        : n.opName === 'SlideConnection' || n.opName === 'Hidden' ? 'Trace' as const
            : n.opName === 'SlideEndFlick' ? 'EndFlick' as const
                : 'End' as const;
    return {
        noteId: n.id,
        timeMs: n.timeMs,
        tick: n.tick,
        laneFloat: n.laneStartFloat,
        laneStartFloat: n.laneStartFloat,
        laneEndFloat: n.laneEndFloat,
        kind
    };
}

function toTracePoint(n: NnNote): TracePoint {
    return {
        timeMs: n.timeMs,
        laneFloat: n.laneStartFloat,
        laneStartFloat: n.laneStartFloat,
        laneEndFloat: n.laneEndFloat
    };
}

/**
 * 滑条链组装。
 * 优先使用谱面内嵌的 lines 定义(权威: noteIds 为节点, comboIds 为路径插值点, 含 Hidden 辅助顶点);
 * 无 lines 字段时回退到按 note.lineIds(滑条线编号)分组。
 */
function assembleSlides(raw: NnNotesChart, allById: Map<number, NnNote>): SlideChain[] {
    const chains: SlideChain[] = [];
    const lines = raw.lines ?? [];

    if (lines.length > 0) {
        for (const line of lines) {
            const nodes = (line.noteIds ?? [])
                .map(id => allById.get(id))
                .filter((n): n is NnNote => !!n)
                .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
            if (nodes.length === 0) continue;
            const trace = (line.comboIds ?? [])
                .map(id => allById.get(id))
                .filter((n): n is NnNote => !!n)
                .map(toTracePoint)
                .sort((a, b) => a.timeMs - b.timeMs);
            chains.push({
                id: line.lineId,
                nodes: nodes.map(toSlideNode),
                trace,
                beginMs: nodes[0].timeMs,
                endMs: nodes[nodes.length - 1].timeMs
            });
        }
        return chains;
    }

    // 回退: 按 lineIds 分组
    const grouped = new Map<number, NnNote[]>();
    for (const n of raw.notes) {
        if (!isSlideNote(n)) continue;
        for (const lid of n.lineIds ?? []) {
            let arr = grouped.get(lid);
            if (!arr) {
                arr = [];
                grouped.set(lid, arr);
            }
            arr.push(n);
        }
    }
    for (const [lid, nodes] of grouped) {
        nodes.sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
        const trace: TracePoint[] = [
            ...raw.notes.filter(n => (n.opName === 'Combo' || n.opName === 'Hidden') && (n.lineIds ?? []).includes(lid))
                .map(toTracePoint)
        ].sort((a, b) => a.timeMs - b.timeMs);
        chains.push({
            id: lid,
            nodes: nodes.map(toSlideNode),
            trace,
            beginMs: nodes[0].timeMs,
            endMs: nodes[nodes.length - 1].timeMs
        });
    }
    return chains;
}

/** 由谱面内嵌 bpmChanges 生成 BPM 分段(优先于 tick 推导) */
function bpmSegmentsFromChanges(changes: NnBpmChange[], durationMs: number): BpmSegment[] {
    const sorted = [...changes].sort((a, b) => a.timeMs - b.timeMs);
    return sorted.map((c, i) => ({
        bpm: c.bpm,
        timeStartMs: c.timeMs,
        timeEndMs: i + 1 < sorted.length ? sorted[i + 1].timeMs : durationMs
    }));
}

/** fever 提取: fever===1 开段, fever===2 闭段(假设, 用真实数据验证) */
function extractFever(notes: NnNote[], durationMs: number): FeverSegment[] {
    const segments: FeverSegment[] = [];
    let open: number | undefined;
    for (const n of [...notes].sort((a, b) => a.timeMs - b.timeMs)) {
        if (n.fever === 1 && open === undefined) {
            open = n.timeMs;
        } else if (n.fever === 2 && open !== undefined) {
            segments.push({ startMs: open, endMs: n.timeMs });
            open = undefined;
        }
    }
    if (open !== undefined) segments.push({ startMs: open, endMs: durationMs });
    return segments;
}

export function parseNnNotes(raw: NnNotesChart, header: {
    musicId: number; difficulty: number; title: string; level: number;
    durationMs: number; fullComboCount: number;
}): CanonicalChart {
    if (raw.format !== 'nnnotes.live-score/1') {
        throw new UnsupportedFormatError(`unsupported chart format: ${raw.format}`);
    }

    const judgementNotes = raw.notes.filter(n => n.judgement);
    const comboNotes = raw.notes.filter(n => n.opName === 'Combo');
    const hiddenNotes = raw.notes.filter(n => n.opName === 'Hidden');

    // 判定音符集合 = judgement 为真的音符(含 Combo 路径点, 不含 Hidden 辅助点)
    // 与谱面 judgementNoteCount / 游戏连击数一致(已对 100001=768、100093=1269 验证)
    const notes: CanonicalNote[] = [];
    for (const n of judgementNotes) {
        let type = OP_CLASSIFY[n.opName];
        if (!type && TRACE_OPS.has(n.op)) type = 'Trace';
        if (!type) {
            // 未知 opName 但有判定: 按 judgementType 兜底
            if (n.flick) type = 'Flick';
            else if (n.judgementType === 'SlideBegin') type = 'SlideBegin';
            else if (n.judgementType === 'SlideEnd') type = 'SlideEnd';
            else if (n.judgementType === 'Trace') type = 'Trace';
            else type = 'Tap';
        }
        notes.push(toCanonicalNote(n, type));
    }
    notes.sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);

    const allById = new Map<number, NnNote>();
    for (const n of raw.notes) allById.set(n.id, n);

    const slides = assembleSlides(raw, allById);
    // BPM: 优先使用谱面内嵌 bpmChanges, 否则由 tick/timeMs 推导
    const bpm = raw.bpmChanges && raw.bpmChanges.length > 0
        ? bpmSegmentsFromChanges(raw.bpmChanges, header.durationMs)
        : estimateBpmSegments(judgementNotes, header.durationMs);
    // fever: 优先使用谱面内嵌 fever 段, 否则从音符 fever 标记推导
    const fever: FeverSegment[] = raw.fever && raw.fever.length > 0
        ? raw.fever.map(f => ({ startMs: f.start.timeMs, endMs: f.end.timeMs }))
        : extractFever(raw.notes, header.durationMs);

    return {
        musicId: header.musicId,
        difficulty: header.difficulty,
        laneCount: raw.laneCount,
        durationMs: header.durationMs,
        judgementNoteCount: raw.judgementNoteCount,
        fullComboCount: header.fullComboCount,
        level: header.level,
        title: header.title,
        counts: raw.counts,
        notes,
        slides,
        bpm,
        fever
    };
}

/**
 * 镜像: 轨道翻转 laneCount-1-lane, direction 左右互换。
 * 注意滑条节点/路径点除中心 laneFloat 外还有随时间变化的左右边界 laneStartFloat/laneEndFloat
 * (长条带体由它们绘制), 必须一并镜像并左右互换, 否则带体留在原侧、音符跑到镜像侧。
 */
export function mirrorChart(chart: CanonicalChart): CanonicalChart {
    const mirrorLane = (lane: number) => chart.laneCount - 1 - lane;
    const mirrorDir = (d?: 'Left' | 'Right') => d === 'Left' ? 'Right' : d === 'Right' ? 'Left' : undefined;
    const clone = structuredClone(chart);
    clone.title = `${chart.title}`;
    const mirrorBounds = (b: { laneFloat: number; laneStartFloat: number; laneEndFloat: number }): void => {
        b.laneFloat = mirrorLane(b.laneFloat);
        const start = b.laneStartFloat;
        const end = b.laneEndFloat;
        b.laneStartFloat = mirrorLane(end);
        b.laneEndFloat = mirrorLane(start);
    };
    for (const n of clone.notes) {
        const start = n.laneStartFloat;
        const end = n.laneEndFloat;
        n.laneStartFloat = mirrorLane(end);
        n.laneEndFloat = mirrorLane(start);
        n.laneStart = Math.round(n.laneStartFloat);
        n.laneEnd = Math.round(n.laneEndFloat);
        n.direction = mirrorDir(n.direction);
    }
    for (const s of clone.slides) {
        for (const node of s.nodes) mirrorBounds(node);
        for (const tp of s.trace) mirrorBounds(tp);
    }
    return clone;
}
