import { Event } from '../../types/Event';
import { Server, SERVER_LIST } from '../../types/Server';
import { Image } from '@napi-rs/canvas';
import { assetCacheKey, assetUrl, eventBackgroundUrl, eventLogoUrl } from '../../data/assets';
import { imageFor } from '../../data/imageCache';

/**
 * 活动视图专用的素材加载:**同一素材按区域逐个尝试**。
 *
 * 上游各区域的素材镜像进度并不一致 —— 实测活动数据四个区域都已上线, 但新出的
 * 卡面 / 新曲封面 / 留影缩略图在 tw/kr/en 的镜像上还是 404, 只有 jp 齐全。
 * 与本项目其它地方同一条规则: 本区域没有就借别的区域, 都不行才放弃(返回 undefined, 视图跳过该块)。
 *
 * 借的只是**托管目录**: 同一个卡片 / 歌曲 id 在各区域是同一张图。
 */

/**
 * (请求区域|素材标识) -> 实际取到图的区域。
 * 缺失的素材每个都要试一遍才发现没有(每次一个 404 往返), 一次出图上百张图会拖到几秒,
 * 所以把「哪个区域能取到」记下来, 后续渲染直接命中。
 */
const resolvedRegion = new Map<string, Server | null>();

async function tryAllRegions(server: Server, pathId: string, build: (s: Server) => { url: string; key: string }): Promise<Image | undefined> {
    const memoKey = `${server}|${pathId}`;
    const known = resolvedRegion.get(memoKey);
    if (known !== undefined) {
        if (known === null) return undefined;
        const { url, key } = build(known);
        const img = await imageFor(url, key);
        if (img) return img;
        resolvedRegion.delete(memoKey);   // 之前能取到、现在取不到了 -> 重新探测
    }

    for (const s of [server, ...SERVER_LIST.filter(x => x !== server)]) {
        const { url, key } = build(s);
        const img = await imageFor(url, key);
        if (img) {
            resolvedRegion.set(memoKey, s);
            return img;
        }
    }
    resolvedRegion.set(memoKey, null);
    return undefined;
}

/** 活动图标 / 底图 */
export function eventArtImage(event: Event, kind: 'logo' | 'background'): Promise<Image | undefined> {
    if (kind === 'logo' && !event.logoAsset) return Promise.resolve(undefined);
    const backgroundAsset = String(event.row?.backgroundAsset ?? '');
    if (kind === 'background' && !backgroundAsset) return Promise.resolve(undefined);
    return tryAllRegions(event.server, `${kind}:${kind === 'logo' ? event.logoAsset : backgroundAsset}`, s => kind === 'logo'
        ? { url: eventLogoUrl(s, event.logoAsset), key: assetCacheKey(s, `event/${event.logoAsset}_logo.webp`) }
        : { url: eventBackgroundUrl(s, backgroundAsset), key: assetCacheKey(s, `event/${backgroundAsset}_top.webp`) });
}

/** 任意素材(卡面 / 封面 / 道具图标等): 传区域无关的逻辑路径 */
export function eventAssetImage(server: Server, logicalPath: string, cacheKeyBase: string): Promise<Image | undefined> {
    return tryAllRegions(server, logicalPath, s => ({ url: assetUrl(s, logicalPath), key: assetCacheKey(s, cacheKeyBase) }));
}
