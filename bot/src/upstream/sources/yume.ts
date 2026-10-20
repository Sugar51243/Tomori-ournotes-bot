import { createHash } from 'crypto';
import { DataSourceProfile, SourceRole } from '../../config/sources';
import { SourceFetchPlan } from './plan';

/**
 * Project Yume(https://bdon.yatta.moe)取数方式的翻译层(纯函数, 不发起请求)。
 *
 * 把「规范化 bdon 布局请求」翻译成该源的取数计划:
 * - master 表: {yume}/Resources/en/Master/{表}.json(丢弃 ?v=; 只有一份 en 数据集, 四个区域都映射到它)
 * - 版本清单: 该源没有 current_version.json —— 取站点页面的 HTML, 从中解析/派生版本令牌,
 *   现场合成 bdon 形状的清单(transform), 让既有的 masterdata 客户端无感消费
 * - 图片: {yume}/Resources/en/Assets/AddressableResources/{折叠后的逻辑路径}
 *   (bdon 把末段重复成一层目录 `…/x/x.webp`, yume 是 `…/x.webp`; 仅对已实测验证的种类做换算)
 */

/** 取数计划形状见 ./plan.ts(与 haneoka 翻译器共用); 这里再导出一次保持既有引用不变 */
export type { SourceFetchPlan } from './plan';

/** 已实测验证可机械换算的资产种类(逻辑路径前缀); 其余种类不冒险, 交由下一个源 */
export const YUME_ASSET_KINDS: readonly string[] = [
    'Image/Jacket/',
    'MemberCard/',
    'Character/Image/',
    'SupportCard/',
    'Stamp/',
    'Band/',
    'Gacha/Banner/'
];

/** 合成清单要覆盖的区域键(与 bdon 的 masterdataKey 对齐) */
export const YUME_REGION_KEYS: readonly string[] = ['hk-tw-mo', 'jp', 'kr', 'en'];

/** 表名白名单(URL 末段) */
const TABLE_RE = /\/master\/([A-Za-z0-9_]+\.json)$/;

/**
 * bdon 逻辑路径 → yume 折叠路径: 末段文件名与其所在目录同名时去掉那层目录。
 * `Image/Jacket/x/x.webp` → `Image/Jacket/x.webp`; 形状不满足(未验证)→ undefined。
 */
export function collapseAssetPath(logicalPath: string): string | undefined {
    const segments = logicalPath.split('/');
    if (segments.some(s => !s || s === '.' || s === '..')) return undefined;
    if (segments.length < 3) return undefined;
    const last = segments[segments.length - 1];
    const stem = last.replace(/\.[A-Za-z0-9]+$/, '');
    if (!stem || segments[segments.length - 2] !== stem) return undefined;
    return [...segments.slice(0, -2), last].join('/');
}

/** 解析站点页面里内嵌的版本标记; 不存在/畸形返回 undefined */
export function parseYumeVersionHash(html: string): string | undefined {
    const m = html.match(/window\.__VERSION_HASH__\s*=\s*(\{.*?\})\s*;/);
    if (!m) return undefined;
    try {
        const parsed = JSON.parse(m[1]) as { base?: number | string };
        return parsed.base === undefined || parsed.base === null ? undefined : String(parsed.base);
    } catch {
        return undefined;
    }
}

/** 版本令牌: 优先用站点标记, 退化到整页 HTML 哈希; 站点每次部署都会刷新 → 缓存自动失效 */
export function yumeVersionToken(html: string): string {
    const marker = parseYumeVersionHash(html);
    const seed = marker ?? html;
    return `yume-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

/** SPA HTML 字节 → bdon 形状的版本清单字节(四区同一版本) */
export function yumeVersionManifestFromHtml(data: Buffer): Buffer {
    const token = yumeVersionToken(data.toString('utf8'));
    const regions: Record<string, { version: string; resource_version: string }> = {};
    for (const key of YUME_REGION_KEYS) {
        regions[key] = { version: token, resource_version: '' };
    }
    return Buffer.from(JSON.stringify({ schema_version: 1, regions, fetchedAt: Date.now() }));
}

/** 规范化 bdon 布局 URL → yume 取数计划; undefined = 该源不参与这个请求 */
export function yumeFetchPlan(canonicalUrl: string, role: SourceRole, profile: DataSourceProfile): SourceFetchPlan | undefined {
    let u: URL;
    try {
        u = new URL(canonicalUrl);
    } catch {
        return undefined;
    }

    if (role === 'meta') {
        if (u.pathname.endsWith('/current_version.json')) {
            if (!profile.versionSourceUrl) return undefined;
            return { url: profile.versionSourceUrl, transform: yumeVersionManifestFromHtml };
        }
        const table = u.pathname.match(TABLE_RE);
        if (!table) return undefined;
        return { url: `${profile.metaBase}/${table[1]}` };
    }

    if (role === 'asset') {
        // 规范化形状: {base}/{region}/{locale}/{逻辑路径...}
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length < 4) return undefined;                    // 至少 region/locale/目录/文件
        const logical = segments.slice(2).join('/');
        if (!YUME_ASSET_KINDS.some(kind => logical.startsWith(kind))) return undefined;
        const collapsed = collapseAssetPath(logical);
        if (!collapsed) return undefined;
        return { url: `${profile.assetBase}/${collapsed}` };
    }

    return undefined;
}
