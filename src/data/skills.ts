import { masterdataClient } from './masterdata/client';
import { t } from './masterdata/text';

/**
 * 技能解析: 主数据中的技能由「技能表(名称/描述模板) + 效果表(各级数值)」组成,
 * 描述模板形如 "【简单】{effects[0].time:F1}秒内得分<color=#66FF8C>提升{effects[0].value/100:F1}%</color>"。
 * 本模块按最高等级的效果值将模板套成可读文本(去除 color 标签; 含无法解析占位符的行整行丢弃)。
 */

export type SkillKind = 'leader' | 'live' | 'gekisou' | 'support';

interface SkillTableSpec {
    skillTable: string;
    effectTable: string;
    /** 效果表中指向技能 id 的字段(已剥离下划线前缀) */
    effectSkillField: string;
}

const SKILL_SPECS: Record<SkillKind, SkillTableSpec> = {
    leader: { skillTable: 'MasterLeaderSkill', effectTable: 'MasterLeaderSkillEffect', effectSkillField: 'leaderSkillID' },
    live: { skillTable: 'MasterLiveSkill', effectTable: 'MasterLiveSkillEffect', effectSkillField: 'liveSkillID' },
    gekisou: { skillTable: 'MasterGekisouSkill', effectTable: 'MasterGekisouSkillEffect', effectSkillField: 'gekisouSkillID' },
    // 击奏支援技能与支援技能共用表(由 id 区分)
    support: { skillTable: 'MasterSupportSkill', effectTable: 'MasterSupportSkillEffect', effectSkillField: 'supportSkillID' }
};

export interface SkillInfo {
    id: number;
    kind: SkillKind;
    /** 技能名(本地化) */
    name: string;
    /** 套用最高等级数值后的描述(可能多行) */
    description: string;
    /** 技能等级上限 */
    maxLevel: number;
    /** 展示用标签(由卡片字段决定: 队长技能/演出技能/击奏技能/支援技能/击奏支援技能) */
    label?: string;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** 模板中 effects[N].<字段> 的字段名到效果表列名的映射 */
const EFFECT_FIELDS: Record<string, string> = {
    value: 'effectValue',
    time: 'activationTimeSecond',
    limitCount: 'effectLimitCount',
    maxValue: 'maxEffectValue'
};

/** 在（可能含字符串字面量的）表达式中查找顶层分隔符的位置 */
function findTopLevel(str: string, token: string): number {
    let inQuote = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '"') inQuote = !inQuote;
        else if (!inQuote && str.startsWith(token, i)) return i;
    }
    return -1;
}

/**
 * 求值表达式(支持的形式见技能描述模板):
 * - 字符串字面量: "JUST激奏期间"
 * - 效果字段: effects[0].value/100:F1 / effects[0].time:F1 / effects[0].limitCount
 * - 拼接: a ~ b
 * - 三元: 0 < effects[0].time ? "A" : "B"
 * 无法求值时返回 undefined(调用方决定如何处置该行)。
 */
function evalExpr(expr: string, effects: Row[]): string | undefined {
    const trimmed = expr.trim();
    // 三元
    const q = findTopLevel(trimmed, '?');
    if (q >= 0) {
        const colon = findTopLevel(trimmed.slice(q + 1), ':');
        if (colon >= 0) {
            const condExpr = trimmed.slice(0, q).trim();
            const thenExpr = trimmed.slice(q + 1, q + 1 + colon).trim();
            const elseExpr = trimmed.slice(q + 1 + colon + 1).trim();
            const cond = evalCondition(condExpr, effects);
            if (cond === undefined) return undefined;
            return evalExpr(cond ? thenExpr : elseExpr, effects);
        }
    }
    // 拼接
    if (trimmed.includes('~')) {
        const parts = trimmed.split('~').map(p => evalExpr(p, effects));
        if (parts.some(p => p === undefined)) return undefined;
        return parts.join('');
    }
    // 字符串字面量
    const strLit = trimmed.match(/^"([\s\S]*)"$/);
    if (strLit) return strLit[1];
    // effects[N].字段(可带 /除数 与 :F精度)
    const m = trimmed.match(/^effects\[(\d+)\]\.([A-Za-z]+)(?:\/([\d.]+))?(?::F(\d))?$/);
    if (m) {
        const row = effects[Number(m[1])];
        const column = EFFECT_FIELDS[m[2]];
        if (!row || !column) return undefined;
        const value = num(row[column]) / (m[3] ? Number(m[3]) : 1);
        return m[4] !== undefined ? value.toFixed(Number(m[4])) : String(value);
    }
    return undefined;
}

function evalCondition(cond: string, effects: Row[]): boolean | undefined {
    const m = cond.match(/^([\d.]+)\s*<\s*effects\[(\d+)\]\.([A-Za-z]+)$/);
    if (m) {
        const row = effects[Number(m[2])];
        const column = EFFECT_FIELDS[m[3]];
        if (!row || !column) return undefined;
        return num(row[column]) > Number(m[1]);
    }
    return undefined;
}

// ---- 内存索引: 按 id 建表, 避免每次技能查询都扫描整张表 ----
const skillRowCache = new Map<string, Map<number, Row>>();
const effectRowCache = new Map<string, Map<number, Row[]>>();

/** dataVersion 变化时清空索引(由 masterdata store 调用) */
export function resetSkillCache(): void {
    skillRowCache.clear();
    effectRowCache.clear();
}

async function skillRowById(table: string): Promise<Map<number, Row>> {
    let map = skillRowCache.get(table);
    if (!map) {
        const rows = await masterdataClient.getTable<Row>(table).catch(() => []);
        map = new Map(rows.map(r => [num(r.id), r]));
        skillRowCache.set(table, map);
    }
    return map;
}

async function effectRowsBySkill(table: string, field: string): Promise<Map<number, Row[]>> {
    const key = `${table}.${field}`;
    let map = effectRowCache.get(key);
    if (!map) {
        const rows = await masterdataClient.getTable<Row>(table).catch(() => []);
        map = new Map<number, Row[]>();
        for (const r of rows) {
            const id = num(r[field]);
            const arr = map.get(id);
            if (arr) arr.push(r);
            else map.set(id, [r]);
        }
        effectRowCache.set(key, map);
    }
    return map;
}

/**
 * 将描述模板中的 {…} 占位符按给定效果行套值。
 * 无法求值的占位符(主要是条件目标名 effects[N].con[…].targets[…].name, 需条件目标表)替换为「特定」,
 * 以保留整句语义; 若替换后仍残留未识别的占位符, 则丢弃该行, 避免把模板语法暴露给用户。
 */
function renderTemplate(template: string, effects: Row[]): string {
    const stripped = template
        .replace(/<color=#[0-9A-Fa-f]+>|<\/color>/gi, '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\r\n/g, '\n');
    const lines: string[] = [];
    for (const rawLine of stripped.split('\n')) {
        const filled = rawLine.replace(/\{([^{}]+)\}/g, (_m, expr: string) => {
            const value = evalExpr(expr, effects);
            if (value !== undefined) return value;
            // 条件目标名等暂不可求值: 用中性词占位
            return expr.includes('.targets[') ? '特定' : '\u0000';
        });
        if (filled.includes('\u0000')) continue;      // 含未识别占位符 -> 丢弃该行
        if (filled.trim()) lines.push(filled.trim());
    }
    return lines.join('\n');
}

/** 读取技能信息(名称 + 按最高等级套值的描述); 未找到返回 undefined */
export async function getSkill(kind: SkillKind, skillId: number): Promise<SkillInfo | undefined> {
    if (!skillId || skillId <= 0) return undefined;
    const spec = SKILL_SPECS[kind];
    const skill = (await skillRowById(spec.skillTable)).get(skillId);
    if (!skill) return undefined;

    const name = await t(String(skill.nameTextID ?? ''));
    const template = await t(String(skill.descriptionTextFormatID ?? ''));

    const effectRows = (await effectRowsBySkill(spec.effectTable, spec.effectSkillField)).get(skillId) ?? [];
    const levels = [...new Set(effectRows.map(r => num(r.level)))].sort((a, b) => a - b);
    const maxLevel = levels.length ? levels[levels.length - 1] : 1;
    // 取最高等级那一组效果, 顺序即模板里 effects[i] 的下标
    const maxRows = effectRows.filter(r => num(r.level) === maxLevel);

    return {
        id: skillId,
        kind,
        name: name || `技能#${skillId}`,
        description: renderTemplate(template, maxRows),
        maxLevel
    };
}

/** 批量读取(忽略缺失项; 第三项为展示标签) */
export async function getSkills(entries: [SkillKind, number, string?][]): Promise<SkillInfo[]> {
    const out: SkillInfo[] = [];
    for (const [kind, id, label] of entries) {
        const info = await getSkill(kind, id);
        if (info) {
            info.label = label;
            out.push(info);
        }
    }
    return out;
}

/** 按等级组读取卡片等级上限(成员卡/支援卡各自的等级表) */
export async function getMaxLevel(table: 'MasterMemberCardLevel' | 'MasterSupportCardLevel', group: number): Promise<number | undefined> {
    if (!group) return undefined;
    const rows = await masterdataClient.getTable<Row>(table).catch(() => []);
    const levels = rows.filter(r => num(r.group) === group).map(r => num(r.level));
    return levels.length ? Math.max(...levels) : undefined;
}
