import { config } from '../config';
import { cachedFetch } from './cachedFetch';

/**
 * 资源 URL 构造与图片加载。
 * 所有资源 URL 规则集中在此(均已对真实 CDN 逐条验证)。
 */

export function jacketUrl(jacketAssetName: string, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/Image/Jacket/${jacketAssetName}/${jacketAssetName}.webp`;
}

// 资源 URL 规则(已逐一对真实 CDN 验证): {locale}/{路径}/{文件名}/{文件名}.webp
export function cardFullArtUrl(cardId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/MemberCard/${cardId}/member_full/member_full.webp`;
}

export function cardThumbUrl(cardId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/MemberCard/${cardId}/member_thumbnail/member_thumbnail.webp`;
}

export function characterIconUrl(characterId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/Character/Image/${characterId}/character_face_icon/character_face_icon.webp`;
}

export function characterSpriteUrl(characterId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/Character/Image/${characterId}/character_sprite/character_sprite.webp`;
}

export function supportCardThumbUrl(assetId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/SupportCard/${assetId}/snap_thumbnail/snap_thumbnail.webp`;
}

export function supportCardFullUrl(assetId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/SupportCard/${assetId}/snap_full/snap_full.webp`;
}

/** 道具图标: imagePath 形如 "Item/exp/item_icon_exp_004" */
export function itemIconUrl(imagePath: string, locale = config.defaultLocale): string {
    const name = imagePath.split('/').at(-1) ?? imagePath;
    return `${config.assetBase}/${locale}/${imagePath}/${name}.webp`;
}

/** 贴纸: stampAsset 形如 "Stamp/illust/stamp_illust_tomori_001" / "Stamp/text/stamp_text_001"(无缩略图变体) */
export function stampUrl(stampAsset: string, locale = config.defaultLocale): string {
    const name = stampAsset.split('/').at(-1) ?? stampAsset;
    return `${config.assetBase}/${locale}/${stampAsset}/${name}.webp`;
}

export function bandLogoUrl(bandId: number, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/Band/${bandId}/band_logo/band_logo.webp`;
}

export function gachaBannerUrl(bannerAssetName: string, locale = config.defaultLocale): string {
    // bannerAssetName 形如 "Gacha/Banner/gacha_banner_00001"
    return `${config.assetBase}/${locale}/${bannerAssetName}/${bannerAssetName.split('/').at(-1)}.webp`;
}

/** 背景图: 名称形如 bg_adv_0103 / OfflineBonusBackground */
export function backgroundUrl(name: string, locale = config.defaultLocale): string {
    return `${config.assetBase}/${locale}/Image/Background/${name}/${name}.webp`;
}

export function chartManifestUrl(musicId: number, difficulty: string): string {
    return `${config.assetBase}/chart-site/charts/${musicId}_${difficulty}.json`;
}

export function chartAssetUrl(sha: string, ext: string): string {
    return `${config.assetBase}/chart-site/assets/${sha}.${ext}`;
}

/** 加载图片 Buffer(cachedFetch 包装, 允许陈旧回退) */
export async function imageBuffer(url: string, cacheKey: string): Promise<Buffer | undefined> {
    const res = await cachedFetch(url, { key: cacheKey, ttlS: config.imageTtlS, allowStale: true });
    return res?.data;
}
