import { Image, loadImage } from '@napi-rs/canvas';
import { getChartManifest, getChartPart, DifficultyName } from '../chart/client';
import { logger } from '../logger';

/**
 * 官方音符皮肤素材加载:
 * 从谱面 bundle 的 livenotes/notes.json(noteSkin 部件)解析精灵定义,
 * 下载 skin001 贴图集并加载为 Image。内容寻址, 内存缓存复用。
 */

export interface SpriteRect { x: number; y: number; width: number; height: number; }
export interface SpriteDef {
    name: string;
    rect: SpriteRect;
    /** 九宫格边框(纹理像素): left=border.x, right=border.z */
    border: { left: number; right: number; top: number; bottom: number };
}

/**
 * 各类音符的官方主体精灵(取自对应 NoteSkinAssetUnit 的 _mainSprite)。
 * 注意划键按方向有专属身体素材: 左划绿色、右划粉红、无方向金色。
 */
export interface NoteBodySprites {
    tap?: SpriteDef;          // TapNoteAsset
    slide?: SpriteDef;        // SlideNoteAsset
    slideEnd?: SpriteDef;     // SlideEndNoteAsset
    slideConnect?: SpriteDef; // SlideConnectNoteAsset
    trace?: SpriteDef;        // TraceNoteAsset
    flick?: SpriteDef;        // FlickNoteAsset(无方向)
    flickLeft?: SpriteDef;    // LeftFlickNoteAsset
    flickRight?: SpriteDef;   // RightFlickNote
}

export interface NoteSkin {
    atlas: Image;
    sprites: Map<string, SpriteDef>;
    /** 采样自 lane_base 的演奏区底色 */
    laneBaseColor: string;
    /** 各类音符主体精灵 */
    bodies: NoteBodySprites;
    /**
     * 官方划键箭头素材(按音符宽度选取): 方向 -> 按 _maxWidth 升序的候选列表。
     * 与游戏一致: 窄音符用短箭头、宽和弦用长箭头, 避免箭头被拉伸/裁切变形。
     */
    arrowAssets: Record<'Normal' | 'Left' | 'Right', { maxWidth: number; sprite: SpriteDef }[]>;
}

interface RawSprite {
    sprite?: string;
    texture?: { texture?: string };
    textureRect?: SpriteRect;
    border?: { x?: number; y?: number; z?: number; w?: number };
}

function collectSprites(node: unknown, out: Map<string, SpriteDef>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) collectSprites(item, out);
        return;
    }
    const obj = node as RawSprite & Record<string, unknown>;
    if (obj.sprite && obj.textureRect) {
        if (!out.has(obj.sprite)) {
            out.set(obj.sprite, {
                name: obj.sprite,
                rect: obj.textureRect,
                border: {
                    left: obj.border?.x ?? 0,
                    right: obj.border?.z ?? 0,
                    top: obj.border?.y ?? 0,
                    bottom: obj.border?.w ?? 0
                }
            });
        }
    }
    for (const value of Object.values(obj)) collectSprites(value, out);
}

/** 从各 NoteSkinAssetUnit 的 _mainSprite 提取音符主体精灵 */
function collectBodies(json: Record<string, unknown>, sprites: Map<string, SpriteDef>): NoteBodySprites {
    const bodies: NoteBodySprites = {};
    const mapping: [keyof NoteBodySprites, string][] = [
        ['tap', 'TapNoteAsset'],
        ['slide', 'SlideNoteAsset'],
        ['slideEnd', 'SlideEndNoteAsset'],
        ['slideConnect', 'SlideConnectNoteAsset'],
        ['trace', 'TraceNoteAsset'],
        ['flick', 'FlickNoteAsset'],
        ['flickLeft', 'LeftFlickNoteAsset'],
        ['flickRight', 'RightFlickNote']
    ];
    for (const [key, unitName] of mapping) {
        const unit = json[unitName] as { _mainSprite?: RawSprite } | undefined;
        const name = unit?._mainSprite?.sprite;
        if (name) bodies[key] = sprites.get(name);
    }
    return bodies;
}

/** 从划键资产单元(FlickNoteAsset/LeftFlickNoteAsset/RightFlickNote)提取按宽度选取的箭头素材 */
function collectArrowAssets(json: Record<string, unknown>, sprites: Map<string, SpriteDef>): NoteSkin['arrowAssets'] {
    const result: NoteSkin['arrowAssets'] = { Normal: [], Left: [], Right: [] };
    const units: [keyof NoteSkin['arrowAssets'], string][] = [
        ['Normal', 'FlickNoteAsset'],
        ['Left', 'LeftFlickNoteAsset'],
        ['Right', 'RightFlickNote']
    ];
    for (const [direction, unitName] of units) {
        const unit = json[unitName] as { _arrowAssets?: { _maxWidth?: number; _sprite?: RawSprite }[] } | undefined;
        for (const entry of unit?._arrowAssets ?? []) {
            const name = entry._sprite?.sprite;
            if (!name) continue;
            const sprite = sprites.get(name);
            if (!sprite) continue;
            result[direction].push({ maxWidth: entry._maxWidth ?? Number.MAX_SAFE_INTEGER, sprite });
        }
        result[direction].sort((a, b) => a.maxWidth - b.maxWidth);
    }
    return result;
}

/** 找到第一个精灵引用的贴图路径(如 textures/sactx-...-skin001-....png) */
function findAtlasPath(node: unknown): string | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findAtlasPath(item);
            if (found) return found;
        }
        return undefined;
    }
    const obj = node as RawSprite & Record<string, unknown>;
    if (obj.texture?.texture) return obj.texture.texture;
    for (const value of Object.values(obj)) {
        const found = findAtlasPath(value);
        if (found) return found;
    }
    return undefined;
}

const ATLAS_MEMORY = new Map<string, Promise<Image>>();
const SKIN_MEMORY = new Map<string, Promise<NoteSkin>>();

async function loadAtlas(sha: string, ext: string): Promise<Image> {
    let pending = ATLAS_MEMORY.get(sha);
    if (!pending) {
        pending = (async () => {
            const { getChartAsset } = await import('../chart/client');
            const buf = await getChartAsset(sha, ext);
            return await loadImage(buf);
        })();
        ATLAS_MEMORY.set(sha, pending);
    }
    return pending;
}

export async function getNoteSkin(musicId: number, difficulty: DifficultyName): Promise<NoteSkin | undefined> {
    const manifest = await getChartManifest(musicId, difficulty);
    const entry = manifest.files['livenotes/notes.json'];
    if (!entry) return undefined;
    const skinPart = entry.parts?.find(([name]) => name === 'noteSkin');
    if (!skinPart) return undefined;
    const cacheKey = skinPart[1];

    let pending = SKIN_MEMORY.get(cacheKey);
    if (!pending) {
        pending = (async (): Promise<NoteSkin> => {
            const raw = await getChartPart(manifest, 'livenotes/notes.json', 'noteSkin');
            const json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            const sprites = new Map<string, SpriteDef>();
            collectSprites(json, sprites);
            const atlasPath = findAtlasPath(json);
            if (!atlasPath) throw new Error('note skin atlas path not found');
            const manifestKey = `livenotes/${atlasPath}`;
            const atlasEntry = manifest.files[manifestKey];
            if (!atlasEntry) throw new Error(`atlas not in manifest: ${manifestKey}`);
            const sha = atlasEntry.asset.replace(/^assets\//, '').replace(/\.[^.]+$/, '');
            const ext = atlasEntry.asset.slice(atlasEntry.asset.lastIndexOf('.')).replace(/^\./, '');
            const atlas = await loadAtlas(sha, ext);
            const arrowAssets = collectArrowAssets(json, sprites);
            const bodies = collectBodies(json, sprites);
            logger('noteSkin', `loaded skin ${sha.slice(0, 12)} with ${sprites.size} sprites, bodies: ${Object.keys(bodies).join('/')}, arrows: N=${arrowAssets.Normal.length} L=${arrowAssets.Left.length} R=${arrowAssets.Right.length}`);
            return { atlas, sprites, laneBaseColor: '#0B1129', bodies, arrowAssets };
        })();
        // 失败不缓存, 允许后续重试
        pending.catch(() => SKIN_MEMORY.delete(cacheKey));
        SKIN_MEMORY.set(cacheKey, pending);
    }
    return pending;
}
