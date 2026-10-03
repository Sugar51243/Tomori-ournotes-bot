import { config } from '../../config';
import { ttl } from '../../config/ttl';
import { cachedJSON, cachedFetch } from '../cachedFetch';
import { chartManifestUrl, chartAssetUrl } from '../assets';
import { ChartManifest, NnNotesChart } from '../../features/types/Chart';
import { logger } from '../../logger';

/** 四档难度的规范名(顺序即难度下标) */
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
export type DifficultyName = (typeof DIFFICULTIES)[number];

/** 难度下标(0-3)→ 规范名; 越界返回 undefined */
export function difficultyIdToName(id: number): DifficultyName | undefined {
    return DIFFICULTIES[id];
}

/** 谱面资源取数失败(找不到清单/资源文件) */
export class ChartFetchError extends Error { }

/** 谱面清单: {musicId}_{difficulty}.json (TTL 7d, ETag 重验证, 允许陈旧回退) */
export async function getChartManifest(musicId: number, difficulty: DifficultyName): Promise<ChartManifest> {
    const key = `charts/manifests/${musicId}_${difficulty}.json`;
    return cachedJSON<ChartManifest>(chartManifestUrl(musicId, difficulty), {
        key,
        ttlS: ttl.chartManifestTtlS,
        allowStale: true,
        revalidate: true
    });
}

/** 按 sha256 下载任意 chart-site 资源(内容寻址, 长 TTL) */
export async function getChartAsset(sha: string, ext: string): Promise<Buffer> {
    const res = await cachedFetch(chartAssetUrl(sha, ext), {
        key: `charts/assets/${sha}.${ext}`,
        ttlS: ttl.chartAssetTtlS,
        allowStale: true
    });
    if (!res) throw new ChartFetchError(`failed to fetch asset ${sha}.${ext}`);
    return res.data;
}

/** 清单内逻辑路径 -> 资源下载(仅单文件条目; multipart 条目请用 getChartPart) */
export async function getChartFile(manifest: ChartManifest, logicalPath: string): Promise<Buffer> {
    const entry = manifest.files[logicalPath];
    if (!entry) throw new ChartFetchError(`file not in manifest: ${logicalPath}`);
    if (entry.parts && entry.parts.length > 0) {
        // multipart 条目是"多个逻辑文件的集合", 不是可拼接的整体, 需按名字取部件
        throw new ChartFetchError(`multipart entry, use getChartPart: ${logicalPath}`);
    }
    const sha = entry.asset.replace(/^assets\//, '').replace(/\.[^.]+$/, '');
    const ext = entry.asset.slice(entry.asset.lastIndexOf('.')).replace(/^\./, '');
    return getChartAsset(sha, ext);
}

/** multipart 条目(如 livenotes/notes.json)中按名字取单个部件 */
export async function getChartPart(manifest: ChartManifest, logicalPath: string, partName: string): Promise<Buffer> {
    const entry = manifest.files[logicalPath];
    if (!entry?.parts) throw new ChartFetchError(`not a multipart entry: ${logicalPath}`);
    const part = entry.parts.find(([name]) => name === partName);
    if (!part) throw new ChartFetchError(`part not found: ${logicalPath}#${partName}`);
    const [, asset] = part;
    const sha = asset.replace(/^assets\//, '').replace(/\.[^.]+$/, '');
    const ext = asset.slice(asset.lastIndexOf('.')).replace(/^\./, '');
    return getChartAsset(sha, ext);
}

function splitAsset(asset: string): { sha: string; ext: string } {
    return {
        sha: asset.replace(/^assets\//, '').replace(/\.[^.]+$/, ''),
        ext: asset.slice(asset.lastIndexOf('.')).replace(/^\./, '')
    };
}

/**
 * 读取 bundle 中逻辑路径的 JSON 文件。
 * 兼容两种打包方式:
 * - 单文件条目: { asset: "assets/<sha>.json" }
 * - multipart 条目: { parts: [[键名, "assets/<sha>.json", size], ...] } —— 每个部件是一个
 *   顶层键的 JSON 值(如 format/mirror/notes/lines/bpmChanges/...), 按键名组装回对象。
 *   (已对 score/*.notes.json 与 livenotes/notes.json 两种实例验证)
 */
export async function getChartJSON<T = unknown>(manifest: ChartManifest, logicalPath: string): Promise<T> {
    const entry = manifest.files[logicalPath];
    if (!entry) throw new ChartFetchError(`file not in manifest: ${logicalPath}`);

    if (entry.parts && entry.parts.length > 0) {
        const obj: Record<string, unknown> = {};
        for (const [name, asset] of entry.parts) {
            const { sha, ext } = splitAsset(asset);
            const buf = await getChartAsset(sha, ext);
            try {
                obj[name] = JSON.parse(buf.toString('utf8'));
            } catch {
                // 非 JSON 部件(前向兼容): 跳过并告警, 不中断解析
                logger('chart', `part ${logicalPath}#${name} is not JSON, skipped (${buf.length} bytes)`);
            }
        }
        return obj as T;
    }

    const buf = await getChartFile(manifest, logicalPath);
    return JSON.parse(buf.toString('utf8')) as T;
}

/** 谱面内部编号: setId = musicId-100000 补零 4 位, dd = 难度 00-03 */
export function chartSetId(musicId: number): string {
    return String(musicId - 100000).padStart(4, '0');
}

/** 谱面文件在谱面站里的逻辑路径 */
export function chartNotesPath(musicId: number, difficultyId: number): string {
    return `score/${chartSetId(musicId)}_${String(difficultyId).padStart(2, '0')}.notes.json`;
}

/** 获取 nnnotes 谱面数据(自动处理单文件与 multipart 两种打包) */
export async function getChartNotes(musicId: number, difficultyId: number): Promise<NnNotesChart> {
    const difficulty = difficultyIdToName(difficultyId);
    if (!difficulty) throw new ChartFetchError(`invalid difficultyId: ${difficultyId}`);
    const manifest = await getChartManifest(musicId, difficulty);
    const path = chartNotesPath(musicId, difficultyId);
    try {
        return await getChartJSON<NnNotesChart>(manifest, path);
    } catch (e) {
        logger('chart', `manifest route failed for ${path}, trying direct fallback`);
        const { cachedFetch } = await import('../cachedFetch');
        const res = await cachedFetch(`${config.assetBase}/chart-site/${path}`, {
            key: `charts/files/${musicId}/${path}`,
            ttlS: ttl.chartAssetTtlS,
            allowStale: true
        });
        if (!res) throw e;
        return JSON.parse(res.data.toString('utf8')) as NnNotesChart;
    }
}

/** 获取 live.json 配置(谱面 bundle 元数据, 供需要原始配置的调用方使用) */
export async function getLiveJson(musicId: number, difficulty: DifficultyName): Promise<Record<string, unknown>> {
    const manifest = await getChartManifest(musicId, difficulty);
    const raw = await getChartFile(manifest, 'live.json');
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
}
