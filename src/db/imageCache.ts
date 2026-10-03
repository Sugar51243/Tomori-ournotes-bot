import { Image, loadImage } from '@napi-rs/canvas';
import { config } from '../config';
import { imageBuffer } from '../upstream/adapter';

/**
 * **已解码图片**的内存 LRU。
 *
 * `imageBuffer` 每次都要走磁盘缓存(stat + 读文件 + 读 etag 三次文件系统操作)再解码,
 * 而一次活动出图要取上百张图(横幅、图标、卡面、每个奖励条目的道具图标…),
 * 其中大量是重复的(同一个道具图标出现在多个里程碑里)。
 * 实测 `Event.init()` 只有 0~1ms, 单张解码也只有 0.5~19ms —— 真正贵的是这上百次磁盘往返。
 *
 * 这里按 `assetCacheKey` 缓存解码结果, 命中时只剩一次 Map 查找。
 * 按**解码后字节数**限流(RGBA = 宽×高×4), 超限按 LRU 淘汰。
 */

interface Entry { img: Image; bytes: number }

const entries = new Map<string, Entry>();
let totalBytes = 0;

function evict(): void {
    while (totalBytes > config.imageCacheBytes && entries.size > 0) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        const e = entries.get(oldest.value);
        entries.delete(oldest.value);
        totalBytes -= e?.bytes ?? 0;
    }
}

/** 已解码图片缓存的占用统计(诊断用) */
export function imageCacheStats(): { entries: number; mb: number } {
    return { entries: entries.size, mb: Math.round(totalBytes / 1024 / 1024) };
}

/** 取已解码的图片; 取不到返回 undefined(调用方画占位块) */
export async function imageFor(url: string, cacheKey: string): Promise<Image | undefined> {
    const hit = entries.get(cacheKey);
    if (hit) {
        // LRU: 命中后挪到末尾
        entries.delete(cacheKey);
        entries.set(cacheKey, hit);
        return hit.img;
    }

    const buf = await imageBuffer(url, cacheKey).catch(() => undefined);
    if (!buf) return undefined;
    let img: Image;
    try {
        img = await loadImage(buf);
    } catch {
        return undefined;
    }

    const bytes = img.width * img.height * 4;
    // 单张就超上限的(比如超大的谱面预览素材)不入缓存, 免得把整个缓存顶掉
    if (bytes <= config.imageCacheBytes) {
        entries.set(cacheKey, { img, bytes });
        totalBytes += bytes;
        evict();
    }
    return img;
}
