/**
 * 用户自定义关键词: 给角色 / 角色卡 / 支援卡 / 歌曲挂一个便于检索的别名
 * (外号、简称、罗马音等官方名里没有的写法)。
 *
 * 关键词**参与模糊搜索**, 也会列在详情图的「关键词」栏位里。
 * 上传时做两道查重: 同一实体上不能重复, 且不得与任何现有实体名/别名重合
 * (否则「关键词」会变成对官方名的抢注, 搜索语义会含糊)。
 */
export type KeywordEntityType = 'character' | 'card' | 'supportCard' | 'song' | 'band';

export const KEYWORD_ENTITY_TYPES: readonly KeywordEntityType[] = ['character', 'card', 'supportCard', 'song', 'band'];

/** 实体类型 -> 模糊索引的类型键(与 fuzzyIndex.buildConfig 里 add() 用的键一致) */
export const KEYWORD_FUZZY_TYPES: Record<KeywordEntityType, string> = {
    character: 'characterId',
    card: 'cardId',
    supportCard: 'supportCardId',
    song: 'songId',
    band: 'bandId'
};

/** 实体类型 -> 中文展示名(报错文案与详情图标题用) */
export const KEYWORD_ENTITY_LABELS: Record<KeywordEntityType, string> = {
    character: '角色',
    card: '角色卡',
    supportCard: '支援卡',
    song: '歌曲',
    band: '乐团'
};

export interface KeywordDoc {
    entityType: KeywordEntityType;
    entityId: number;
    /** 用户输入原文(原样保留大小写与标点, 展示用) */
    keyword: string;
    /** 归一化检索键(小写 + 去标点), 与模糊索引同口径; 唯一索引的一部分 */
    normKeyword: string;
    /** 上传者 QQ 号(弱鉴权, 仅留痕) */
    userId: string;
    createdAt: Date;
}

/** 单条关键词长度上限(去首尾空白后) */
export const MAX_KEYWORD_LENGTH = 32;
/** 单个实体的关键词上限: 防止把模糊索引当公告板刷 */
export const MAX_KEYWORDS_PER_ENTITY = 20;
