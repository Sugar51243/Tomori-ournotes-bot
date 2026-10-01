import { clientFor, versionToken } from './data/masterdata/client';
import { regionFor } from './data/region';
import { logger } from './logger';
import { setFuzzyConfig, resetFuzzyConfig, normalizeSearchText, FuzzySearchConfig } from './fuzzySearch';
import { diskCache } from './data/cache';
import { ensureKeywordsLoaded } from './data/keywords';
import { SERVER_LIST, Server } from './types/Server';
import { cardTypeTextIds } from './types/Card';

/**
 * 索引结构版本: 别名类型键(如新增 supportCardId)或别名规则变化时 +1, 使旧缓存自动失效。
 * v1: 歌曲/角色/成员卡/卡池/活动
 * v2: 新增支援卡(supportCardId)、成员卡与支援卡别名分立(两者 ID 空间重叠)
 * v3: 支援卡别名补充关联角色的短名与英文名
 * v4: 新增乐团分类(bandId); 歌曲不再并入乐团别名, 改由乐团分类查询
 * v5: 索引按游戏区域分片(缓存键与内存配置都带 server)
 * v6: 新增贴纸名(stampId); 角色/团体维度复用既有的 characterId / bandId
 * v7: 新增卡片属性(cardType), 供活动按「加成属性」检索
 * v8: 别名改为**跨区域取并集** —— 上游 jp 的 MasterText 几乎没有中文列,
 *     只按本区域取文本会让日服索引只有日文别名, 中文查询在日服上搜不到
 */
const FUZZY_INDEX_VERSION = 8;

/**
 * 别名索引构建: 由本区域 masterdata 生成模糊搜索配置。
 * 歌曲名/乐队名/角色名/卡名(成员卡与支援卡)/卡池名/活动名 多语言(zh-Hans/zh-TW/ja/en/ko)别名。
 * 按「区域 + dataVersion」构建一次并持久化到磁盘(文件名携带两者与索引版本, 任一变化自然失效)。
 */
async function buildConfig(server: Server): Promise<FuzzySearchConfig> {
    const config: FuzzySearchConfig = {};
    const { store, t } = regionFor(server);

    /**
     * 一个 textId 的全部语言别名 —— **跨区域取并集**。
     *
     * 只问本区域是不够的: 上游 jp 的 MasterText 里实体文本几乎只有日文列
     * (实测 1083 条 textId 完全没有中文, 其中 1082 条能在 tw 找到中文),
     * 于是日服索引只剩日文别名, 中文用户搜不到日服曲目。
     * 各区域指向同一实体的 textId 是同一个(歌曲/角色/卡/乐团实测 0 例外),
     * 所以把四个区域对同一 textId 的取值并起来既安全又完整。
     *
     * 指定 locale 时仍走各自区域的回退链 —— 顺便并入各区域默认语言下的写法。
     */
    const localeVariants = async (textId: string): Promise<string[]> => {
        const out = new Set<string>();
        // 故意枚举全部语种: 中文用户要能用中文名搜到只有日文文本的日服曲目
        const locales = ['zh-Hans', 'zh-TW', 'ja', 'en', 'ko'];
        for (const source of SERVER_LIST) {
            const resolve = source === server ? t : regionFor(source).t;
            for (const loc of locales) {
                const v = await resolve(textId, loc);
                if (v && v !== textId) out.add(v.toLowerCase());
            }
        }
        return [...out];
    };

    // 生成短别名: 去掉标点符号的变体(如 "MyGO!!!!!" -> "mygo"), 提升匹配率
    const aliasVariants = (names: string[]): string[] => {
        const out = new Set<string>();
        for (const name of names) {
            const lower = name.toLowerCase();
            out.add(lower);
            const stripped = normalizeSearchText(lower);
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
    // 卡片属性(绯红/绀碧/翡翠/琉金/紫苑) -> 类型键 cardType; 主要供活动按「加成属性」检索
    for (const [value, textId] of Object.entries(cardTypeTextIds)) {
        const names = await localeVariants(textId);
        add('cardType', value, aliasVariants([
            ...names,
            // 官方文案形如「绯红属性 / 紅赤タイプ」, 去掉后缀让「绯红」也能命中
            ...names.map(n => n.replace(/\s*(属性|屬性|タイプ|타입|types?|type)$/i, '').trim())
        ]));
    }
    // 贴纸(名称多语言) -> 类型键 stampId; 角色名/团体名的命中走 characterId / bandId 两个既有类型
    for (const stamp of await store.stampList()) {
        add('stampId', stamp.id, aliasVariants(await localeVariants(stamp.nameTextId)));
    }
    // 活动(表可能为空)
    for (const event of events) {
        const nameId = String((event as Record<string, unknown>).nameTextId ?? (event as Record<string, unknown>).eventNameTextId ?? '');
        if (nameId) add('eventId', event.id, aliasVariants(await localeVariants(nameId)));
    }

    return config;
}

/**
 * 确保本区域的模糊索引已构建(版本变化时重建), 并把用户关键词并入。
 * @returns 该区域索引的缓存键 —— 关键词查重需要用它判断「四区域索引是否换过代」
 */
export async function ensureFuzzyIndex(server: Server): Promise<string> {
    // 直接问本区域的客户端, 以它认定的版本为准(与表缓存的版本一致)
    const { dataVersion } = await clientFor(server).getDataVersion();
    // 缓存键含索引结构版本: 别名类型键发生变化时需手动 +1, 否则会命中旧结构的缓存
    const cacheKey = `fuzzy/${server}/${versionToken(dataVersion)}_v${FUZZY_INDEX_VERSION}.json`;
    // 关键词来自数据库, 不写进上面这份磁盘缓存, 而是作为独立覆盖层合并(见 fuzzySearch.setKeywordOverlay)
    await ensureKeywordsLoaded();
    const cached = await diskCache.read(cacheKey);
    if (cached) {
        setFuzzyConfig(server, JSON.parse(cached.data.toString('utf8')) as FuzzySearchConfig);
        return cacheKey;
    }
    resetFuzzyConfig(server);
    const cfg = await buildConfig(server);
    await diskCache.write(cacheKey, Buffer.from(JSON.stringify(cfg)));
    setFuzzyConfig(server, cfg);
    logger('fuzzyIndex', `[${server}] built fuzzy index for version ${dataVersion}: ${Object.keys(cfg).map(k => `${k}(${Object.keys(cfg[k]).length})`).join(', ')}`);
    return cacheKey;
}
