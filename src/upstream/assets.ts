import { config } from '../config';
import { ttl } from '../config/ttl';
import { Server, serverProfile } from '../features/types/Server';
import { cachedFetch } from './cachedFetch';

/**
 * 资源 URL 构造与图片加载。
 * URL 形状: {assetBase}/{assetRegion}/{locale}/{路径}/{文件名}/{文件名}.webp
 *
 * 各区域 CDN 上的语言目录并不齐全 —— jp 只有 ja,拼 zh-Hans 会 404,
 * 所以取图语言一律经 assetLocaleFor 收敛到该区域真实存在的目录。
 * chart-site 是全站共享资源,不带区域段。
 */

function profile(server: Server) {
    return serverProfile(server);
}

/** 把请求语言收敛到该区域 CDN 上真实存在的目录 */
export function assetLocaleFor(server: Server, locale?: string): string {
    const p = profile(server);
    if (locale && p.assetLocales.includes(locale)) return locale;
    if (p.assetLocales.includes(p.defaultLocale)) return p.defaultLocale;
    return p.assetLocales[0] ?? p.defaultLocale;
}

/** 通用资源 URL: path 形如 "Image/Jacket/jkt_001_100020/jkt_001_100020.webp" */
export function assetUrl(server: Server, path: string, locale?: string): string {
    return `${config.assetBase}/${profile(server).assetRegion}/${assetLocaleFor(server, locale)}/${path}`;
}

/**
 * 图片磁盘缓存键。区域与语言都进键 —— URL 两者都含,
 * 否则 tw 与 jp 的同名素材会互相覆盖。
 */
export function assetCacheKey(server: Server, logicalPath: string, locale?: string): string {
    return `images/${server}/${assetLocaleFor(server, locale)}/${logicalPath}`;
}

/** 歌曲封面 URL; jacketAssetName 形如 jkt_001_100020 */
export function jacketUrl(server: Server, jacketAssetName: string, locale?: string): string {
    return assetUrl(server, `Image/Jacket/${jacketAssetName}/${jacketAssetName}.webp`, locale);
}

// 资源 URL 规则(已逐一对真实 CDN 验证): {region}/{locale}/{路径}/{文件名}/{文件名}.webp
export function cardFullArtUrl(server: Server, cardId: number, locale?: string): string {
    return assetUrl(server, `MemberCard/${cardId}/member_full/member_full.webp`, locale);
}

/** 成员卡缩略图 URL */
export function cardThumbUrl(server: Server, cardId: number, locale?: string): string {
    return assetUrl(server, `MemberCard/${cardId}/member_thumbnail/member_thumbnail.webp`, locale);
}

/** 角色头像图标 URL */
export function characterIconUrl(server: Server, characterId: number, locale?: string): string {
    return assetUrl(server, `Character/Image/${characterId}/character_face_icon/character_face_icon.webp`, locale);
}

/** 角色立绘 URL */
export function characterSpriteUrl(server: Server, characterId: number, locale?: string): string {
    return assetUrl(server, `Character/Image/${characterId}/character_sprite/character_sprite.webp`, locale);
}

/** 支援卡缩略图 URL(assetId 即卡面资产 id) */
export function supportCardThumbUrl(server: Server, assetId: number, locale?: string): string {
    return assetUrl(server, `SupportCard/${assetId}/snap_thumbnail/snap_thumbnail.webp`, locale);
}

/** 支援卡完整卡面 URL */
export function supportCardFullUrl(server: Server, assetId: number, locale?: string): string {
    return assetUrl(server, `SupportCard/${assetId}/snap_full/snap_full.webp`, locale);
}

/** 道具图标: imagePath 形如 "Item/exp/item_icon_exp_004" */
export function itemIconUrl(server: Server, imagePath: string, locale?: string): string {
    const name = imagePath.split('/').at(-1) ?? imagePath;
    return assetUrl(server, `${imagePath}/${name}.webp`, locale);
}

/** 贴纸: stampAsset 形如 "Stamp/illust/stamp_illust_tomori_001" / "Stamp/text/stamp_text_001"(无缩略图变体) */
export function stampUrl(server: Server, stampAsset: string, locale?: string): string {
    const name = stampAsset.split('/').at(-1) ?? stampAsset;
    return assetUrl(server, `${stampAsset}/${name}.webp`, locale);
}

/** 乐团横版 logo URL */
export function bandLogoUrl(server: Server, bandId: number, locale?: string): string {
    return assetUrl(server, `Band/${bandId}/band_logo/band_logo.webp`, locale);
}

/** 乐团小图标(方形, 62x62): 列表格里用它, 比横版 band_logo 更合适 */
export function bandSmallIconUrl(server: Server, bandId: number, locale?: string): string {
    return assetUrl(server, `Band/${bandId}/band_small_Icon/band_small_Icon.webp`, locale);
}

/** 卡池 banner URL; bannerAssetName 形如 Gacha/Banner/gacha_banner_00001 */
export function gachaBannerUrl(server: Server, bannerAssetName: string, locale?: string): string {
    // bannerAssetName 形如 "Gacha/Banner/gacha_banner_00001"
    return assetUrl(server, `${bannerAssetName}/${bannerAssetName.split('/').at(-1)}.webp`, locale);
}

/**
 * 活动图标: asset 形如 "01/Logo/event_logo_01_0001"
 * 规则实测: {assetBase}/{region}/{locale}/Image/Event/{asset}/{末段}.webp
 */
export function eventLogoUrl(server: Server, logoAsset: string, locale?: string): string {
    const name = logoAsset.split('/').at(-1) ?? logoAsset;
    return assetUrl(server, `Image/Event/${logoAsset}/${name}.webp`, locale);
}

/** 活动顶图: asset 形如 "01/Top/event_top_01_0001" */
export function eventBackgroundUrl(server: Server, backgroundAsset: string, locale?: string): string {
    const name = backgroundAsset.split('/').at(-1) ?? backgroundAsset;
    return assetUrl(server, `Image/Event/${backgroundAsset}/${name}.webp`, locale);
}

/** 背景图: 名称形如 bg_adv_0103 / OfflineBonusBackground */
export function backgroundUrl(server: Server, name: string, locale?: string): string {
    return assetUrl(server, `Image/Background/${name}/${name}.webp`, locale);
}

/** 服务器国旗图标(bdon.moe 站点资源, 与素材 CDN 不同源) */
export function flagUrl(flagFile: string): string {
    return `${config.moenotesSiteBase}/flags/${flagFile}.svg`;
}

/** 国旗图标的磁盘缓存键(与服务器无关, 全服共用) */
export function flagCacheKey(flagFile: string): string {
    return `images/flags/${flagFile}.svg`;
}

/** 谱面站点是全区共享的, 不带区域段 */
export function chartManifestUrl(musicId: number, difficulty: string): string {
    return `${config.assetBase}/chart-site/charts/${musicId}_${difficulty}.json`;
}

/** 谱面资源 URL(内容寻址: sha 即内容) */
export function chartAssetUrl(sha: string, ext: string): string {
    return `${config.assetBase}/chart-site/assets/${sha}.${ext}`;
}

/**
 * 加载图片 Buffer(cachedFetch 包装, 允许陈旧回退)。
 *
 * **任何失败都返回 undefined, 绝不抛异常** —— 上游素材缺失(新出的卡面/封面在部分区域的镜像
 * 还没跟上时会 404)或网络故障时, 调用方一律按「没图」处理(画占位块或跳过),
 * 不能让单张图把整次出图打成 500。所有调用点本来就都在判 undefined。
 */
export async function imageBuffer(url: string, cacheKey: string): Promise<Buffer | undefined> {
    const res = await cachedFetch(url, { key: cacheKey, ttlS: ttl.imageTtlS, allowStale: true }).catch(() => undefined);
    return res?.data;
}
