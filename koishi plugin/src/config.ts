/**
 * 常量、文案与配置类型。
 *
 * 单独成文件（而不是像参考项目那样把 Config 放在 index.ts）是为了避免
 * features/* 反向 import index.ts 造成循环依赖。
 *
 * 区域（服务器）相关的东西在 ./server.ts。
 */

/** Tomori 后端默认地址。注意：后端 .env.example 写的是 3000，实际部署常在 3002。 */
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3002'

/**
 * 后端契约版本。
 *
 * 本插件对应 **Tomori 后端 1.2.0 及以上**（与后端 package.json 的版本同步走）。
 *
 * 请求体那套契约本身是 **1.1.0** 起定的：查询输入走 `id`、服务器走 `displayedServerList`，
 * 并删掉了旧的 `server` / `mainServer` 字段（旧字段会被静默忽略，查出来的服是错的）。
 * 这项要求没变过，所以 1.1.x 的后端其实也能对上 —— 但对外只报最新对应版本，
 * 免得用户以为"装了 1.1.0 就万事大吉"而错过账号包那几项。
 *
 * ⚠ health.ts 里的契约自检**不看这个数字**（后端不上报自己的版本），
 * 而是看特征：`payload.servers` 这个数组在 = 1.1.0 契约在位。改这里只影响提示文案。
 */
export const REQUIRED_BACKEND_VERSION = '1.2.0'

/**
 * 需要配合更旧的后端（1.0.x 及以前）时，回退到这个插件版本。
 *
 * `1.0.0` 是 npm 上真实发布过的最后一版旧契约插件（用 `server` / `mainServer`），
 * 装它就能和旧后端对上；本地开发里的 0.x 版本号从未发布，不作为回退目标。
 */
export const LEGACY_PLUGIN_VERSION = '1.0.0'

/**
 * 版本兼容与回退指引：配置界面与 readme 共用同一份说法，避免两边漂移。
 * 注意这里是**纯文本**，会直接渲染在 Koishi 的配置页上，别塞 HTML。
 */
export const COMPATIBILITY_NOTE =
  `本插件对应 Tomori 后端 ${REQUIRED_BACKEND_VERSION} 及以上`
  + `（该版本起请求体统一为 id / displayedServerList）；`
  + `绑定 / 发名片 / b25 / 组卡 还需要含 /playerBind/* 等账号包端点的后端（打到旧后端会回 404）；`
  + `后端更旧（1.0.x 及以前）请回退插件到 ${LEGACY_PLUGIN_VERSION}：`
  + `npm i koishi-plugin-tomori-ournotes@${LEGACY_PLUGIN_VERSION}`

/**
 * 难度：Tomori 的 difficultyId 为 0-3 (easy/normal/hard/expert)，**没有 special**。
 * 参考项目 tsugu 的难度表是 ez/nm/hd/ex/sp 五项，这里必须去掉 sp（后端校验 min:0 max:3）。
 */
/** 短码，按 difficultyId 顺序 */
export const DIFFICULTY_SUFFIXES = ['ez', 'nm', 'hd', 'ex'] as const
/** 用户写法（小写）→ difficultyId；短码与全名都认 */
export const DIFFICULTY_ALIASES: Record<string, number> = {
  ez: 0, easy: 0,
  nm: 1, normal: 1,
  hd: 2, hard: 2,
  ex: 3, expert: 3,
}
/** 与后端 /songChart 的默认值一致 */
export const DEFAULT_DIFFICULTY_ID = 3

/**
 * 谱面预览的流速（后端 noteSpeed）。默认值与范围取自后端
 * `src/components/OurNotesPreview.ts` 的 NOTE_SPEED_DEFAULT / MIN / MAX。
 * 省略时插件不发这个字段，由后端用它自己的默认值。
 */
export const NOTE_SPEED_MIN = 1
export const NOTE_SPEED_MAX = 12

/** 卡片种类：/searchCard 与 /getCardIllustration 的 cardType */
export type CardKind = 'member' | 'support' | 'auto'
export const CARD_KIND_ALIASES: Record<string, CardKind> = {
  member: 'member', 角色卡: 'member', 成员卡: 'member', 卡: 'member',
  support: 'support', 支援卡: 'support', 留影: 'support',
  auto: 'auto', 自动: 'auto',
}

/**
 * 组卡模式（后端 `/deckBuilder` 的 mode）。
 * - `normal` 最高综合力 + 效率曲
 * - `event`  活动推荐 + 收益/小时（不指定活动时用进行中的活动）
 * - `auto`   有进行中的活动就按活动模式（后端默认值）
 */
export type DeckMode = 'normal' | 'event' | 'auto'
export const DECK_MODE_ALIASES: Record<string, DeckMode> = {
  normal: 'normal', 常规: 'normal', 普通: 'normal', 综合力: 'normal', 最高综合力: 'normal',
  event: 'event', 活动: 'event',
  auto: 'auto', 自动: 'auto',
}

/**
 * 用户自定义关键词的实体类型（后端 `/keyword/*` 的 entityType）。
 *
 * 与 `CardKind` 是**两套命名空间**，别混：这里 `角色卡` 指 member card 这个实体，
 * 而 `/searchCard` 的 cardType 里的 `support`/`member` 是「查哪一类卡」。
 */
export type KeywordEntityType = 'character' | 'card' | 'supportCard' | 'song' | 'band'
export const KEYWORD_TYPE_ALIASES: Record<string, KeywordEntityType> = {
  character: 'character', 角色: 'character',
  card: 'card', 角色卡: 'card', 成员卡: 'card',
  supportcard: 'supportCard', 支援卡: 'supportCard', 留影: 'supportCard',
  song: 'song', 歌曲: 'song',
  band: 'band', 乐团: 'band', 乐队: 'band',
}
/** 与后端 MAX_KEYWORD_LENGTH 一致 */
export const MAX_KEYWORD_LENGTH = 32

/**
 * 后端支持的榜线档位（`/cutoffAll` 的 CUTOFF_TIERS）。
 *
 * **只用于用法提示**，不参与解析也不做校验 —— 名次/档位现在严格按位置认
 * （见 parse.ts 的 parseTierArgs），能不能用由后端按实际数据判定，
 * 不适配时它会回一句「当前可用档位: …」。
 */
export const CUTOFF_TIERS = [10, 100, 1000, 5000, 10000] as const
/** `ycx` 不写名次时用的档位（与参考实现一致） */
export const DEFAULT_CUTOFF_TIER = 100

/**
 * 贴纸检索的匹配维度（后端 stampType）：关键词只认哪一类名称。
 *
 * `all` 虽然也是后端接受的取值，但它是**默认行为**，插件不需要显式发它
 * （不传 stampType 就是 all），所以别名表里不放 —— 免得跟 STAMP_ALL_KEYWORDS
 * 里的 `all`（列出全部贴纸）撞车。
 */
export type StampScope = 'all' | 'character' | 'band'
export const STAMP_SCOPE_ALIASES: Record<string, StampScope> = {
  character: 'character', 角色: 'character', 角色名: 'character', 成员: 'character', 成员名: 'character',
  band: 'band', 团体: 'band', 乐团: 'band', 乐队: 'band', 团名: 'band',
}
/** 「列出该服全部贴纸」的关键词（后端：不传 stampId/text 即全量列表） */
export const STAMP_ALL_KEYWORDS = ['全部', '所有', '列表', 'all']
/** 取消公告订阅的关键词 */
export const SUBSCRIPTION_CLOSE_KEYWORDS = ['关闭', '取消', '停用', '退订', 'off']

/**
 * 统一文案。后端自身的域内错误形如 `错误: xxx`，这里只放插件侧产生的提示。
 *
 * 必填参数缺省不在这里 —— Koishi 会用 `prompt-argument` 自己去问，
 * 根本不会调到 action（见 index.ts 里各指令的参数声明）。
 */
export const MESSAGES = {
  backendUnavailable: 'Tomori 后端不可用，请检查 backendURL 配置或后端是否已启动',
  emptyText: '请提供要查询的内容',
  noChartData: '没有取到该谱面的数据',
  unsupportedSpecial: 'Our Notes 没有 special 难度，可选：ez / nm / hd / ex',
  invalidCardId: '卡面 ID 应该是一串数字',
  invalidPlayerId: '玩家 ID 应该是一串数字',
  playerIdOnlyOne: '只能写一个玩家 ID',
  serverNeedsPlayerId: '不写玩家 ID 时用的是绑定里的默认账号，服务器由绑定决定；要查某个服请带上玩家 ID，例如：查玩家 2000000000 jp',
  invalidPlayerPage: '页码要写成「页2」或「第2页」这样（从 1 起）',
  playerPageOnlyOne: '只能指定一个页码',
  bindSelectorUsage: '账号用玩家 ID 或列表序号指定（1~3 位数字按序号），例如：默认玩家 2',
  missingBindCode: '指令使用方式：绑定玩家 <绑定码>（到网页「我的账号」给账号包生成绑定码）',
  deckArgsUsage: '组卡只认「玩家ID / 常规|活动[ID]|自动 / 服务器」，例如：组卡 活动 123 jp、组卡 2000000000',
  invalidCardType: '卡片种类可选 member（角色卡）/ support（支援卡），省略则由后端自动判断',
  invalidNoteSpeed: `速度要写成「速度7.5」这样，范围 ${NOTE_SPEED_MIN} ~ ${NOTE_SPEED_MAX}`,
  invalidTimes: '抽卡次数应该是正整数',
  invalidRoomNumber: '房间号看起来不对（应为 5-7 位数字），例如：上传车牌 1234567 上车',
  missingRoomNumber: '指令使用方式：上传车牌 <房间号> [备注]',
  invalidKeywordType: '类型只支持 角色 / 角色卡 / 支援卡 / 歌曲 / 乐团，例如：新增关键词 歌曲 100001 迷星叫',
  invalidKeywordEntityId: '实体 ID 应该是一串数字（正整数）',
  missingKeyword: '请提供关键词，例如：新增关键词 歌曲 100001 迷星叫',
  keywordTooLong: `关键词过长（上限 ${MAX_KEYWORD_LENGTH} 字）`,
  eventIdOnly: '参数只支持活动 ID 或活动名与服务器，例如：活动推荐 123 jp',
  eventRankArgsOnly: '参数只支持名次 / 活动 ID 或活动名 / 服务器，例如：活动歌榜 100 1 jp',
  cutoffArgsOnly: '参数只支持档位 / 活动 ID 或活动名 / 服务器，例如：ycx 100 1 jp',
  missingPlayerId: '指令使用方式：交友登记 <游戏ID> [服务器]',
  sessionRequired: '这个指令需要在会话里使用',
  missingUserId: '拿不到你的用户 ID',
  unparsableBody: '后端返回了无法解析的内容',
  stubPrefix: '这个指令对应的功能 Tomori 后端还没有实现',
  stubHint: '可用「后端状态」查看后端情况',
  /** 订阅公告推流 */
  missingSubscribeServer: '请指定要订阅的服务器，例如：公告订阅 tw',
  subscriptionDisabled: '（注意：机器人侧公告推流未启用，暂时收不到推送）',
  noSubscription: '本会话还没有订阅任何服务器公告',
} as const
