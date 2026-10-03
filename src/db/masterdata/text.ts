import { clientFor } from './client';
import { TextRow } from '../../features/types/MasterData';
import { Server, serverProfile, serverChainList } from '../../features/types/Server';

// MasterText 行: { id, japanese, english, traditionalChinese, simplifiedChinese, korean }
const LOCALE_FIELDS: Record<string, keyof TextRow> = {
    'zh-Hans': 'simplifiedChinese',
    'zh-CN': 'simplifiedChinese',
    'zh-hans': 'simplifiedChinese',
    'zh-TW': 'traditionalChinese',
    'zh-Hant': 'traditionalChinese',
    ja: 'japanese',
    'ja-JP': 'japanese',
    en: 'english',
    'en-US': 'english',
    ko: 'korean',
    'ko-KR': 'korean'
};

/**
 * 该区域的文本回退链。
 *
 * **指定了服务器就以该服务器的语言为准**: 区域自己的默认语言排在最前 ——
 * 港澳台出简体中文、日服出日文、韩服出韩文、国际服出英文。
 * 区域语言缺失时才依次退到该区域的次级语言、**默认服务器回退链上各服的语言**(语言随链回退)、最后 ja/en。
 *
 * 实测各区域的 MasterText 覆盖度: tw/kr/en 五语种齐全(同一份文件),
 * jp 以日文为主(9924 行里只有 60 行带中文、58 行带韩文), 所以日服基本只会出日文, 属上游数据所限。
 */
function chainFor(server: Server, locale?: string): string[] {
    const profile = serverProfile(server);
    return [
        locale ?? '',
        profile.defaultLocale,
        ...profile.localeFallbacks,
        ...serverChainList().map(s => serverProfile(s).defaultLocale),
        'ja',
        'en'
    ];
}

function pick(row: TextRow, chain: string[]): string | undefined {
    for (const loc of chain) {
        if (!loc) continue;
        const field = LOCALE_FIELDS[loc];
        if (!field) continue;
        const v = String(row[field] ?? '').trim();
        if (v) return v;
    }
    // 最后兜底: 任意非空值(保证模糊索引不会索引到空别名)
    for (const key of Object.keys(row)) {
        if (key === 'id') continue;
        const v = String((row as unknown as Record<string, string>)[key] ?? '').trim();
        if (v) return v;
    }
    return undefined;
}

export interface TextResolver {
    /** 按区域回退链解析本地化文本; 找不到返回原始 textId */
    t(textId: string, locale?: string): Promise<string>;
    /** 同步版本: 要求文本已预加载(preload), 供无法 await 的绘图路径使用 */
    tSync(textId: string, locale?: string): string;
    preload(): Promise<void>;
    reset(): void;
}

/** 每个区域一个文本解析器(磁盘/内存缓存天然隔离) */
export function createTextResolver(server: Server): TextResolver {
    let rows = new Map<string, TextRow>();

    async function ensureLoaded(): Promise<Map<string, TextRow>> {
        if (rows.size > 0) return rows;
        const table = await clientFor(server).getTable<Record<string, unknown>>('MasterText');
        const map = new Map<string, TextRow>();
        for (const row of table) {
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
        rows = map;
        return map;
    }

    return {
        async t(textId: string, locale?: string): Promise<string> {
            if (!textId) return '';
            const map = await ensureLoaded();
            const row = map.get(textId);
            if (!row) return textId;
            return pick(row, chainFor(server, locale)) ?? textId;
        },
        tSync(textId: string, locale?: string): string {
            const row = rows.get(textId);
            if (!row) return textId;
            return pick(row, chainFor(server, locale)) ?? textId;
        },
        async preload(): Promise<void> {
            await ensureLoaded();
        },
        reset(): void {
            rows = new Map();
        }
    };
}
