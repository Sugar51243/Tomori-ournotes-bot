// Our Notes 谱面类型定义 (nnnotes.live-score/1)

// ---- 原始 nnnotes 格式 ----
export interface NnNote {
    id: number;
    op: number;
    opName: string;
    timeMs: number;
    bar: number;
    rhythm: number;
    rhythmicUnit: number;
    barProgress: number;
    laneStart: number;
    laneEnd: number;
    laneStartFloat: number;
    laneEndFloat: number;
    width: number;
    critical?: boolean;
    direction?: 'Normal' | 'Left' | 'Right';
    slideAlong?: boolean;
    lineIds?: number[];
    lineEase?: 'Linear' | 'EaseIn' | 'EaseOut';
    lineEaseR?: string;
    pairNoteId?: number;
    fever?: number | null;
    judgement: boolean;
    flick?: boolean;
    judgementType?: string;
    judgementAreaOffset?: string;
    tick: number;
    laneIndexFloat?: number;
    widthFloat?: number;
    laneIndex?: number;
    laneWidth?: number;
    lineIndices?: number[];
    visible?: boolean;
    alpha?: string | number;
    src?: unknown[];
    lineBeginId?: number;
    lineEndId?: number;
}

/** 谱面内嵌的真实 BPM 变更(部分谱面提供) */
export interface NnBpmChange {
    bpm: number;
    bar: number;
    rhythm: number;
    rhythmicUnit: number;
    barProgress: number;
    timeMs: number;
}

/** 谱面内嵌的 fever 段(部分谱面提供) */
export interface NnFeverSegment {
    index: number;
    start: { bar: number; rhythm: number; timeMs: number };
    end: { bar: number; rhythm: number; timeMs: number };
}

/** 谱面内嵌的滑条线定义(部分谱面提供, 权威的链结构) */
export interface NnLine {
    lineId: number;
    type: string;
    /** 滑条节点音符 id(按序, 含 Hidden 辅助点) */
    noteIds: number[];
    /** 路径插值点(Combo)音符 id */
    comboIds: number[];
}

export interface NnNotesChart {
    format: string;
    mirror: boolean;
    startNoteId: number;
    laneCount: number;
    judgementNoteCount: number;
    counts: Record<string, number>;
    notes: NnNote[];
    // ---- 以下为部分谱面(如 100093)提供的富字段 ----
    /** 真实 BPM 变更(存在时优先于推导值) */
    bpmChanges?: NnBpmChange[];
    /** 真实 fever 段(存在时优先于从 fever 标记推导) */
    fever?: NnFeverSegment[];
    /** 滑条线定义(存在时优先于按 lineIds 分组) */
    lines?: NnLine[];
    /** 小节线时间(ms) */
    barLineTimeMs?: number[];
    /** 最后一个音符时间 */
    lastNoteTimeMs?: number;
}

// ---- 谱面清单 (chart-site bundle manifest) ----
export interface ChartFileEntry {
    asset: string;
    size: number;
    parts?: [string, string, number][];
}

export interface ChartManifest {
    audio: boolean;
    audioFormat: string;
    builder: string;
    chart: {
        bandIds: number[];
        bands: string[];
        displayLevel: number;
        durationMs: number;
        fullComboCount: number;
        level: number;
        notes: number;
        sortOrder: number;
        stageBand: number;
        title: string;
    };
    difficulty: string;
    files: Record<string, ChartFileEntry>;
    flows: string[];
    format: number;
    inputs: string;
    musicId: number;
    quality: number;
    template: string;
}

// ---- 内部规范化模型 ----
/**
 * 规范化音符类型(与官方渲染类型一一对应):
 * - Tap/Flick/FlickDirection 由 op1 与 op40/41/42 按方向决定(Flick 系列含 direction 字段)
 * - SlideConnect = op21 可见连接节点; Trace = op60-63/104/105 轨迹点
 * - Combo = op120 判定但不可见(计入连击, 不绘制)
 */
export type CanonicalNoteType =
    | 'Tap' | 'Flick'
    | 'SlideBegin' | 'SlideBeginFlick'
    | 'SlideConnect' | 'SlideEnd' | 'SlideEndFlick'
    | 'Trace' | 'Combo';

export interface CanonicalNote {
    id: number;
    type: CanonicalNoteType;
    timeMs: number;
    tick: number;
    bar: number;
    rhythm: number;
    laneStart: number;
    laneEnd: number;
    laneStartFloat: number;
    laneEndFloat: number;
    width: number;
    critical: boolean;
    direction?: 'Left' | 'Right';
    fever: number | null;
    pairNoteId?: number;
    judgementType?: string;
    /** 谱面数据中的 visible 字段(仅作信息保留, 不用于渲染判断: op101 等为 false 但游戏仍显示) */
    visible: boolean;
}

export interface SlideNode {
    noteId: number;
    timeMs: number;
    tick: number;
    /** 中心参考位置(渲染退化时使用) */
    laneFloat: number;
    /** 该时刻滑条左右边界(随时间变化, 用于绘制长条带) */
    laneStartFloat: number;
    laneEndFloat: number;
    kind: 'Begin' | 'Trace' | 'End' | 'EndFlick';
}

export interface TracePoint {
    timeMs: number;
    laneFloat: number;
    laneStartFloat: number;
    laneEndFloat: number;
}

export interface SlideChain {
    id: number;
    nodes: SlideNode[];
    trace: TracePoint[];
    beginMs: number;
    endMs: number;
}

export interface BpmSegment {
    bpm: number;
    timeStartMs: number;
    timeEndMs: number;
    estimated?: boolean;
}

export interface FeverSegment {
    startMs: number;
    endMs: number;
}

export interface CanonicalChart {
    musicId: number;
    difficulty: number;
    laneCount: number;
    durationMs: number;
    judgementNoteCount: number;
    fullComboCount: number;
    level: number;
    title: string;
    counts: Record<string, number>;
    notes: CanonicalNote[];
    slides: SlideChain[];
    bpm: BpmSegment[];
    fever: FeverSegment[];
}

/** 简化格式的滑条路径点: lane=左边界, laneEnd=右边界 */
export interface SlidePointSimple { timeMs: number; lane: number; laneEnd: number; }

// ---- 简化公开格式 ----
export interface SimpleNote {
    timeMs: number;
    lane: number;
    laneEnd: number;
    width: number;
    type: 'tap' | 'flick' | 'slideBegin' | 'slideBeginFlick' | 'slideConnect' | 'slideEnd' | 'slideEndFlick' | 'trace' | 'combo';
    direction?: 'Left' | 'Right';
    critical: boolean;
    fever: number | null;
    /** 谱面数据中的 visible 字段(信息用, 不代表渲染与否) */
    visible: boolean;
}

export interface SimpleChart {
    musicId: number;
    difficulty: string;
    level: number;
    title: string;
    durationMs: number;
    laneCount: number;
    counts: Record<string, number>;
    bpm: { segments: BpmSegment[]; value: number };
    notes: SimpleNote[];
    slides: { beginMs: number; endMs: number; nodes: SlidePointSimple[]; trace: SlidePointSimple[] }[];
    fever: { startMs: number; endMs: number }[];
}
