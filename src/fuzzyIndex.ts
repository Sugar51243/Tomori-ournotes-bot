import { masterdataClient } from './data/masterdata/client';
import { store, t } from './data/masterdata';
import { logger } from './logger';
import { setFuzzyConfig, FuzzySearchConfig } from './fuzzySearch';
import { diskCache } from './data/cache';

/**
 * 索引结构版本: 别名类型键(如新增 supportCardId)或别名规则变化时 +1, 使旧缓存自动失效。
 * v1: 歌曲/角色/成员卡/卡池/活动
 * v2: 新增支援卡(supportCardId)、成员卡与支援卡别名分立(两者 ID 空间重叠)
 * v3: 支援卡别名补充关联角色的短名与英文名
 * v4: 新增乐团分类(bandId); 歌曲不再并入乐团别名, 改由乐团分类查询
 */
const FUZZY_INDEX_VERSION = 4;

/**
 * 别名索引构建: 由 masterdata 生成模糊搜索配置。
 * 歌曲名/乐队名/角色名/卡名(成员卡与支援卡)/卡池名/活动名 多语言(zh-Hans/zh-TW/ja/en)别名。
 * 按 dataVersion 构建一次并持久化到磁盘(文件名携带 dataVersion 与索引版本, 任一变化自然失效)。
 */
async function buildConfig(): Promise<FuzzySearchConfig> {
    const config: FuzzySearchConfig = {};

    const localeVariants = async (textId: string): Promise<string[]> => {
        const out = new Set<string>();
        for (const loc of ['zh-Hans', 'zh-TW', 'ja', 'en', 'ko']) {
            const v = await t(textId, loc);
            if (v && v !== textId) out.add(v.toLowerCase());
        }
        return [...out];
    };

    // 生成短别名: 去掉标点符号的变体(如 "MyGO!!!!!" -> "mygo"), 提升匹配率
    const aliasVariants = (names: string[]): string[] => {
        const out = new Set<string>();
        for (const name of names) {
            const lower = name.toLowerCase();
            out.add(lower);
            const stripped = lower.replace(/[^0-9a-z一-鿿぀-ヿ가-힯]/g, '');
            if (stripped) out.add(stripped);
        }
        return [...out];
    };

    const add = (type: string, key: string | number, values: (string | number)[]) => {
        if (values.length === 0) return;
        (config[type] ??= {})[String(key)] = values.map(v => typeof v === 'string' ? v.toLowerCase() : v);
    };

    const songs = await store.songs();
    const scores = await store.songScores();
    const bands = await store.bandList();
    const characters = await store.characters();
    const cards = await store.cardList();
    const gachas = await store.gachaList();
    const events = await store.eventList();

    // 类型名与各模型的 fuzzyTarget 属性名对应(match() 按属性名匹配)
    // 乐团: 独立分类, 供"整体同名"查询按乐团取歌/卡/角色(不再把乐团名并进每首歌的别名)
    for (const band of bands) {
        add('bandId', band.id, aliasVariants(await localeVariants(band.nameTextID)));
    }
    // 歌曲: 仅标题多语言
    for (const song of songs) {
        const aliases = aliasVariants(await localeVariants(song.titleTextID));
        const levels = scores.filter(s => Math.floor(s.id / 100) === song.id).map(s => s.musicScoreLevel);
        add('songId', song.id, aliases);
        add('songLevels', song.id, levels);
    }
    // 角色
    for (const c of characters) {
        const aliases = aliasVariants([
            ...await localeVariants(c.nameTextID),
            ...await localeVariants(c.shortNameTextID),
            ...await localeVariants(c.enDisplayNameTextId),
            ...await localeVariants(c.enDisplayShortNameTextId)
        ]);
        add('characterId', c.id, aliases);
    }
    // 成员卡(名称+角色名+稀有度标签) -> 类型键 cardId
    for (const card of cards) {
        const char = characters.find(c => c.id === card.characterID);
        const aliases = aliasVariants([
            ...await localeVariants(card.nameTextID),
            ...await localeVariants(card.subtitleTextID),
            ...(char ? await localeVariants(char.nameTextID) : [])
        ]);
        aliases.push(`${card.rarity}星`, `★${card.rarity}`);
        add('cardId', card.id, aliases);
    }
    // 支援卡(名称+关联角色的全名/短名/英文名+稀有度标签) -> 类型键 supportCardId
    // 注意: 成员卡与支援卡 ID 空间重叠(均从 1 起), 必须用独立类型键, 否则 match() 会跨类型误配
    const supportCards = await store.supportCardList();
    for (const sc of supportCards) {
        const charAliases: string[] = [];
        for (const cid of sc.characterIDs ?? []) {
            const ch = characters.find(c => c.id === cid);
            if (!ch) continue;
            charAliases.push(
                ...await localeVariants(ch.nameTextID),
                ...await localeVariants(ch.shortNameTextID),
                ...await localeVariants(ch.enDisplayNameTextId),
                ...await localeVariants(ch.enDisplayShortNameTextId)
            );
        }
        const aliases = aliasVariants([...await localeVariants(sc.nameTextID), ...charAliases]);
        aliases.push(`${sc.rarity}星`, `★${sc.rarity}`);
        add('supportCardId', sc.id, aliases);
    }
    // 卡池
    for (const gacha of gachas) {
        add('gachaId', gacha.id, aliasVariants(await localeVariants(gacha.nameTextId)));
    }
    // 活动(表可能为空)
    for (const event of events) {
        const nameId = String((event as Record<string, unknown>).nameTextId ?? (event as Record<string, unknown>).eventNameTextId ?? '');
        if (nameId) add('eventId', event.id, aliasVariants(await localeVariants(nameId)));
    }

    return config;
}

/** 确保模糊索引已构建(版本变化时重建) */
export async function ensureFuzzyIndex(): Promise<void> {
    const { dataVersion } = await masterdataClient.getDataVersion();
    // 缓存键含索引结构版本: 别名类型键发生变化时需手动 +1, 否则会命中旧结构的缓存
    const cacheKey = `fuzzy/${dataVersion}_v${FUZZY_INDEX_VERSION}.json`;
    const cached = await diskCache.read(cacheKey);
    if (cached) {
        setFuzzyConfig(JSON.parse(cached.data.toString('utf8')) as FuzzySearchConfig);
        return;
    }
    const cfg = await buildConfig();
    await diskCache.write(cacheKey, Buffer.from(JSON.stringify(cfg)));
    setFuzzyConfig(cfg);
    logger('fuzzyIndex', `built fuzzy index for version ${dataVersion}: ${Object.keys(cfg).map(k => `${k}(${Object.keys(cfg[k]).length})`).join(', ')}`);
}
