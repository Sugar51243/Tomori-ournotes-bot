import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { cachedVersionManifest } from '../data/masterdata/client';
import { currentRenderEpoch } from '../renderEpoch';
import { SERVER_LIST, pickServers, serverProfile } from '../types/Server';

/**
 * 渲染结果缓存(进程内 LRU)。
 *
 * 出图的开销几乎全在**画布绘制 + PNG 编码**上 —— 实测 songChart 2.3s 里约 1.4s 是 PNG 编码,
 * 而同一首歌/同一张卡会被反复查询, 每次都重画重编码纯属浪费。
 * 这里按「端点 + 请求体 + 相关区域的 dataVersion」缓存**已经序列化好的响应 JSON**:
 * 命中时直接回字符串, 连 JSON.stringify 都省掉。
 *
 * 只覆盖**确定性**接口 —— 随机类(`/songRandom`、`/gachaSimulate`)与
 * 用户数据/活动类(`/searchPlayer`、`/songRanking`、`/eventRanking`、`/eventRecommend`、`/announcements`、交友/车站)一律不进缓存。
 */

/** 允许缓存的端点(其余一律直通) */
const CACHEABLE = new Set([
    '/searchSong',
    '/songMeta',
    '/songChart',
    '/songChartData',
    '/searchCard',
    '/searchMemberCard',
    '/searchSupportCard',
    '/searchCharacter',
    '/searchBand',
    '/searchGacha',
    // 注意: /searchEvent 刻意不缓存 —— 活动图里有「距开始 / 距结束」倒计时, 必须每次重画;
    // 它依赖的静态数据与图片解码另走 imageFor 内存缓存。
    '/getCardIllustration',
    '/getStampImage',
    '/fuzzySearch'
]);

interface Entry { json: string; bytes: number }
const entries = new Map<string, Entry>();
let totalBytes = 0;

function evict(): void {
    // Map 保持插入顺序, 从头删就是 LRU
    while (totalBytes > config.renderCacheBytes && entries.size > 0) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        const e = entries.get(oldest.value);
        entries.delete(oldest.value);
        totalBytes -= e?.bytes ?? 0;
    }
}

/** 相关区域的 dataVersion; 清单还没加载时不缓存(拿不到失效依据) */
function versionKey(): string | undefined {
    const manifest = cachedVersionManifest();
    if (!manifest) return undefined;
    const parts: string[] = [];
    for (const server of SERVER_LIST) {
        const v = manifest.regions[serverProfile(server).masterdataKey]?.dataVersion;
        if (!v) return undefined;
        parts.push(v);
    }
    return parts.join(',');
}

/** 稳定的请求体序列化(键排序, 避免字段顺序不同导致重复缓存) */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function renderCacheStats(): { entries: number; mb: number } {
    return { entries: entries.size, mb: Math.round(totalBytes / 1024 / 1024) };
}

export function renderCacheMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'POST' || !CACHEABLE.has(req.path)) {
        next();
        return;
    }
    // **多服对比图每次重画**: 只要这次请求会画出多个服务器(显式给多个, 或省略字段按默认四服),
    // 就不进缓存 —— 免得某个服的状态变化(素材镜像跟上、数据补录)在缓存过期前一直显示旧图。
    if (pickServers(req.body ?? {}).length > 1) {
        next();
        return;
    }

    const versions = versionKey();
    if (!versions) {
        next();
        return;
    }
    const key = `${req.path}|${versions}|e${currentRenderEpoch()}|${stableStringify(req.body)}`;

    const hit = entries.get(key);
    if (hit) {
        // LRU: 命中后挪到末尾
        entries.delete(key);
        entries.set(key, hit);
        res.type('application/json').send(hit.json);
        return;
    }

    const originalSend = res.send.bind(res);
    res.send = function (body?: unknown): Response {
        // 路由传进来的是**对象**(Express 之后才序列化), 这里自己序列化一次存起来;
        // 命中时直接回字符串, 省掉那次序列化。字符串响应(如 404 文本)不进缓存。
        if (res.statusCode === 200 && body !== undefined && typeof body !== 'string') {
            const json = JSON.stringify(body);
            const bytes = Buffer.byteLength(json);
            entries.set(key, { json, bytes });
            totalBytes += bytes;
            evict();
        }
        return originalSend(body);
    };
    next();
}

logger('renderCache', `render cache enabled, cap ${(config.renderCacheBytes / 1024 / 1024).toFixed(0)}MB`);
