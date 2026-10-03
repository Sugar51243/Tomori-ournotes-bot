import { NnNote } from '../types/Chart';
import { BpmSegment } from '../types/Chart';

/**
 * BPM 推导: 官方谱面无 BPM 字段, 由 tick/timeMs 推出。
 * tick 单位: 1920 ticks = 1 小节(4/4), 即 480 ticks = 1 拍
 * => bpm = (Δtick/480) / (ΔtimeMs/60000) = Δtick/ΔtimeMs × 125
 * (已对 迷星叫 验证: 相邻拍间隔 480 tick / 316ms -> 189.9 ≈ 190 BPM 正确)
 */
const TICKS_PER_BEAT = 480;
const MS_PER_MIN = 60000;

/** 由相邻音符时间差估算该段的 BPM */
export function bpmFromDelta(dtick: number, dtimeMs: number): number {
    return (dtick / TICKS_PER_BEAT) * (MS_PER_MIN / dtimeMs);
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 由判定音符序列估计 BPM 分段:
 * 1. 相邻音符 Δt >= 200ms 的采样 bpm
 * 2. 窗口 20 中值平滑
 * 3. 中值变化 >5% 持续 >3 样本才分段
 */
export function estimateBpmSegments(notes: NnNote[], durationMs: number): BpmSegment[] {
    const samples: { timeMs: number; bpm: number }[] = [];
    const sorted = [...notes].filter(n => n.tick > 0).sort((a, b) => a.timeMs - b.timeMs);
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1];
        const b = sorted[i];
        const dt = b.timeMs - a.timeMs;
        const dtick = b.tick - a.tick;
        if (dt < 200 || dtick <= 0) continue;
        const bpm = bpmFromDelta(dtick, dt);
        if (bpm < 30 || bpm > 400) continue;
        samples.push({ timeMs: (a.timeMs + b.timeMs) / 2, bpm });
    }

    if (samples.length < 3) {
        return [{ bpm: 120, timeStartMs: 0, timeEndMs: durationMs, estimated: true }];
    }

    // 窗口中值平滑
    const WINDOW = 20;
    const smoothed: { timeMs: number; bpm: number }[] = [];
    for (let i = 0; i < samples.length; i++) {
        const window = samples.slice(Math.max(0, i - WINDOW / 2), Math.min(samples.length, i + WINDOW / 2 + 1));
        smoothed.push({ timeMs: samples[i].timeMs, bpm: median(window.map(s => s.bpm)) });
    }

    // 分段: 相邻中值差 >5% 视为变化候选, 连续 3 样本确认
    const segments: BpmSegment[] = [];
    let segStart = smoothed[0].timeMs;
    let segBpms: number[] = [smoothed[0].bpm];
    let changeStreak = 0;
    for (let i = 1; i < smoothed.length; i++) {
        const prev = median(segBpms);
        const cur = smoothed[i].bpm;
        const diff = Math.abs(cur - prev) / prev;
        if (diff > 0.05) {
            changeStreak++;
            if (changeStreak >= 3) {
                segments.push({
                    bpm: Math.round(median(segBpms) * 10) / 10,
                    timeStartMs: segStart,
                    timeEndMs: smoothed[i - changeStreak].timeMs
                });
                segStart = smoothed[i - changeStreak].timeMs;
                segBpms = smoothed.slice(i - changeStreak, i).map(s => s.bpm);
                changeStreak = 0;
            }
        } else {
            changeStreak = 0;
        }
        segBpms.push(cur);
    }
    segments.push({
        bpm: Math.round(median(segBpms) * 10) / 10,
        timeStartMs: segStart,
        timeEndMs: durationMs
    });

    // 合并过短分段(< 3s)到前一/后一段
    return mergeShortSegments(segments);
}

function mergeShortSegments(segments: BpmSegment[]): BpmSegment[] {
    if (segments.length <= 1) return segments;
    const MIN_LEN = 3000;
    const out: BpmSegment[] = [];
    for (const seg of segments) {
        const len = seg.timeEndMs - seg.timeStartMs;
        if (len < MIN_LEN && out.length > 0) {
            const prev = out[out.length - 1];
            prev.timeEndMs = seg.timeEndMs;
        } else {
            out.push({ ...seg });
        }
    }
    // 首段过短则并入第二段
    if (out.length > 1 && out[0].timeEndMs - out[0].timeStartMs < MIN_LEN) {
        out[1].timeStartMs = out[0].timeStartMs;
        out.shift();
    }
    return out;
}
