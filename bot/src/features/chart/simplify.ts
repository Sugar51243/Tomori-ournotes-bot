import { CanonicalChart, SimpleChart, SimpleNote } from '../types/Chart';
import { DIFFICULTIES } from '../../upstream/adapter';

const NOTE_TYPE_MAP: Record<string, SimpleNote['type']> = {
    Tap: 'tap',
    Flick: 'flick',
    SlideBegin: 'slideBegin',
    SlideBeginFlick: 'slideBeginFlick',
    SlideConnect: 'slideConnect',
    SlideEnd: 'slideEnd',
    SlideEndFlick: 'slideEndFlick',
    Trace: 'trace',
    Combo: 'combo'
};

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

/** CanonicalChart -> SimpleChart(公开简化格式, 全部时间单位 ms) */
export function simplifyChart(chart: CanonicalChart): SimpleChart {
    const notes: SimpleNote[] = chart.notes
        .filter(n => NOTE_TYPE_MAP[n.type])
        .map(n => ({
            timeMs: n.timeMs,
            lane: round2(n.laneStartFloat),
            laneEnd: round2(n.laneEndFloat),
            width: round2(n.laneEndFloat - n.laneStartFloat + 1),
            type: NOTE_TYPE_MAP[n.type],
            direction: n.direction,
            critical: n.critical,
            fever: n.fever,
            visible: n.visible
        }));

    // 时长加权中值 BPM
    let bpmValue = 0;
    if (chart.bpm.length > 0) {
        const values = chart.bpm
            .flatMap(seg => Array(Math.max(1, Math.round((seg.timeEndMs - seg.timeStartMs) / 1000))).fill(seg.bpm));
        bpmValue = round2(values[Math.floor(values.length / 2)] ?? chart.bpm[0].bpm);
    }

    return {
        musicId: chart.musicId,
        difficulty: DIFFICULTIES[chart.difficulty] ?? String(chart.difficulty),
        level: chart.level,
        title: chart.title,
        durationMs: chart.durationMs,
        laneCount: chart.laneCount,
        counts: chart.counts,
        bpm: { segments: chart.bpm, value: bpmValue },
        notes,
        slides: chart.slides.map(s => ({
            beginMs: s.beginMs,
            endMs: s.endMs,
            nodes: s.nodes.map(node => ({ timeMs: node.timeMs, lane: round2(node.laneStartFloat), laneEnd: round2(node.laneEndFloat) })),
            trace: s.trace.map(tp => ({ timeMs: tp.timeMs, lane: round2(tp.laneStartFloat), laneEnd: round2(tp.laneEndFloat) }))
        })),
        fever: chart.fever.map(f => ({ startMs: f.startMs, endMs: f.endMs }))
    };
}
