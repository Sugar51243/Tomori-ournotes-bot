/**
 * 上游数据请求器 · adapter —— 所有上游网络访问的唯一对外出口。
 *
 * 机制层: 经 sources/chain 落到 http / cachedFetch(失败抛出、ETag 重验证、stale 回退、
 * 单飞合并、按 host 限流与重试行为不变), 并按「主源 → 备用源 → bdon.moe 兜底」回退;
 * 磁盘缓存键按源前缀隔离, 结果带 origin(实际供数的源名)供出图标注「数据来源」。
 * 转换层: 新数据源的 URL/数据格式翻译在各 sources 模块里完成, 由本模块统一调度;
 * fetchJSONConverted 是通用的「上游原始形状 -> 应用内部形状」转换入口。
 * 门面层: 具名 re-export 各领域客户端(events/ranking/musicData/player/chart/...)。
 */
import type { CachedFetchOptions, FetchedBuffer } from './cachedFetch';
import { http, HttpStatusError } from './http';
import {
    chainFetchBuffer, chainFetchJSON, chainImageBuffer, chainRequestJSON, chainRequestJSONWithOrigin, UpstreamCrashedError
} from './sources/chain';

export type { CachedFetchOptions, FetchedBuffer };
export { HttpStatusError, UpstreamCrashedError };

/** 走磁盘缓存的上游取数(原始字节); 按数据源链回退, 全部失败时按 4xx 原样/上游崩溃抛出 */
export const fetchCached = chainFetchBuffer;
/** 走磁盘缓存的上游取数(JSON); 解析失败也触发回退 */
export const fetchJSONCached = chainFetchJSON;

/** 通用上游查询入口: 取数 + 调用方提供的数据格式转换(原始 -> 应用) */
export async function fetchJSONConverted<TRaw, TApp>(
    url: string,
    options: CachedFetchOptions,
    convert: (raw: TRaw) => TApp
): Promise<TApp> {
    const raw = await fetchJSONCached<TRaw>(url, options);
    return convert(raw);
}

/** 不走磁盘缓存/ETag 的直接 GET(如带 Authorization 的账号查询); 失败抛出 */
export function requestJSON<T>(url: string, options?: { headers?: Record<string, string>; retries?: number }): Promise<T> {
    return chainRequestJSON<T>(url, options);
}

/** requestJSON 的带 origin 版: 同时返回实际供数的源名(出图标注「数据来源」用) */
export function requestJSONWithOrigin<T>(url: string, options?: { headers?: Record<string, string>; retries?: number }): Promise<{ data: T; origin: string }> {
    return chainRequestJSONWithOrigin<T>(url, options);
}

/** 不走磁盘缓存的直接 GET(原始字节) */
export function requestBuffer(url: string): Promise<Buffer> {
    return http.getBuffer(url);
}

// ---- 门面层: 领域客户端具名导出 ----

/**
 * 取图: 按数据源链逐个源尝试(图片角色), 全部失败返回 undefined ——
 * 与 assets.imageBuffer 的契约一致, 绝不抛异常(调用方一律按「没图」处理)。
 */
export async function imageBuffer(url: string, cacheKey: string): Promise<Buffer | undefined> {
    return chainImageBuffer(url, cacheKey);
}

export {
    assetLocaleFor, assetUrl, assetCacheKey, jacketUrl, cardFullArtUrl, cardThumbUrl,
    characterIconUrl, characterSpriteUrl, supportCardThumbUrl, supportCardFullUrl, itemIconUrl, stampUrl,
    bandLogoUrl, bandSmallIconUrl, gachaBannerUrl, eventLogoUrl, eventBackgroundUrl, backgroundUrl,
    flagUrl, flagCacheKey, chartManifestUrl, chartAssetUrl
} from './assets';
export { isAllowedExternalImage } from './externalImage';
export { getNoteSkin } from './noteSkin';
export type { NoteSkin, SpriteDef, SpriteRect, NoteBodySprites } from './noteSkin';
export { listAnnouncements, getAnnouncement } from './announcements/client';
export type { AnnouncementListResult } from './announcements/client';
export { currentEventTracking, getEventTracking, resolveCurrentEvent } from './events/client';
export type { EventTrackingResult, RawTrackedEvent, CurrentEventResolution } from './events/client';
export { getMusicRanking, getChallengeRanking, fetchedAtFromEtag } from './ranking/client';
export {
    getMusicData, rateOf, perMinuteOf, rankCharts, recommendCharts,
    OVERHEAD_MS, DEFAULT_SKILL_PERCENT, DEFAULT_SKILLS, RECOMMEND_DIFFICULTIES
} from './musicData/client';
export { getPlayerProfile, gatewayConfigured } from './player/client';
export {
    DIFFICULTIES, difficultyIdToName, ChartFetchError, getChartManifest, getChartAsset, getChartFile,
    getChartPart, getChartJSON, chartSetId, chartNotesPath, getChartNotes, getLiveJson
} from './chart/client';
export type { DifficultyName } from './chart/client';
