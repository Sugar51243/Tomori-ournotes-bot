import { masterdataClient } from './client';
import { TextRow } from '../../types/MasterData';
import { config } from '../../config';

// MasterText 行: { id, japanese, english, traditionalChinese, simplifiedChinese, korean }
const LOCALE_FIELDS: Record<string, keyof TextRow> = {
    'zh-Hans': 'simplifiedChinese',
    'zh-CN': 'simplifiedChinese',
    'zh-hans': 'simplifiedChinese',
    'zh-TW': 'traditionalChinese',
    'zh-Hant': 'traditionalChinese',
    'ja': 'japanese',
    'ja-JP': 'japanese',
    'en': 'english',
    'en-US': 'english',
    'ko': 'korean',
    'ko-KR': 'korean'
};

let textRows = new Map<string, TextRow>();

async function ensureLoaded(): Promise<Map<string, TextRow>> {
    if (textRows.size > 0) return textRows;
    const rows = await masterdataClient.getTable<Record<string, unknown>>('MasterText');
    const map = new Map<string, TextRow>();
    for (const row of rows) {
        const id = String(row.id ?? '');
        if (!id) continue;
        map.set(id, {
            id,
            japanese: String(row.japanese ?? ''),
            english: String(row.english ?? ''),
            traditionalChinese: String(row.traditionalChinese ?? ''),
            simplifiedChinese: String(row.simplifiedChinese ?? ''),
            korean: String(row.korean ?? '')
        });
    }
    textRows = map;
    return map;
}

export function resetTextCache(): void {
    textRows = new Map();
}

/** 按 locale 回退链解析本地化文本; 找不到返回原始 textId */
export async function t(textId: string, locale?: string): Promise<string> {
    if (!textId) return '';
    const map = await ensureLoaded();
    const row = map.get(textId);
    if (!row) return textId;

    const chain = new Set<string>([
        locale ?? '',
        config.defaultLocale,
        ...config.localeFallbacks,
        'ja',
        'en'
    ]);
    for (const loc of chain) {
        if (!loc) continue;
        const field = LOCALE_FIELDS[loc];
        if (field) {
            const v = String(row[field] ?? '').trim();
            if (v) return v;
        }
    }
    // 最后兜底: 任意非空值
    for (const key of Object.keys(row)) {
        if (key === 'id') continue;
        const v = String((row as unknown as Record<string, string>)[key] ?? '').trim();
        if (v) return v;
    }
    return textId;
}

/** 同步版本: 要求文本已预加载(供绘图函数在异步上下文外使用) */
export function tSync(textId: string, locale?: string): string {
    const row = textRows.get(textId);
    if (!row) return textId;
    const chain = new Set<string>([locale ?? '', config.defaultLocale, ...config.localeFallbacks, 'ja', 'en']);
    for (const loc of chain) {
        if (!loc) continue;
        const field = LOCALE_FIELDS[loc];
        if (field) {
            const v = String(row[field] ?? '').trim();
            if (v) return v;
        }
    }
    return textId;
}

export const preloadText = ensureLoaded;
