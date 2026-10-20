/**
 * koishi-plugin-tomori-ournotes
 *
 * 《BanG Dream! Our Notes》查询插件，对接 Tomori 后端。
 *
 * 与参考项目 bestdori-tsugu-extra 的关系：指令形态与消息设置保持一致，
 * 但**不做任何客户端渲染与搜索** —— 模糊搜索、24 轨谱面绘制、卡面/贴纸取图、
 * 抽卡模拟全部由 Tomori 后端完成，这里只负责「解析指令 → 组装请求体 → 渲染回复」。
 *
 * ## 服务器（区域）
 *
 * 请求体里的服务器只有一个字段 `displayedServerList`（单值/数组都收），
 * 但取法按数据性质分两类：
 * - **静态实体**（曲/卡/角色/活动/卡池/谱面/贴纸/歌表）：一图多服，请求里是**列表**，默认全部四服。
 * - **动态用户数据**（排行/玩家/公告/抽卡模拟）：单服一图，后端取**首个**、不回退，默认 `tw`。
 *
 * 用户在任何指令的任意位置写服务器短码或别名都会被抽出来（`查曲 迷星叫 jp`、`查曲 jp 100008` 都认）。
 */
import { Schema, h } from 'koishi'
import type { Context } from 'koishi'
import {
  COMPATIBILITY_NOTE,
  CUTOFF_TIERS,
  DEFAULT_BACKEND_URL,
  DEFAULT_CUTOFF_TIER,
  MAX_KEYWORD_LENGTH,
  MESSAGES,
  SUBSCRIPTION_CLOSE_KEYWORDS,
} from './config'
import type { KeywordEntityType } from './config'
import {
  SERVER_LIST,
  normalizeServerList,
  parseServerLoose,
  pickDisplayedServers,
  pickSingleServer,
  serverHint,
} from './server'
import type { Server } from './server'
import { fromSession } from './session'
import {
  parseArgs,
  parseBindSelector,
  parseDeckArgs,
  parseEventArgs,
  parseGachaArgs,
  parseKeywordType,
  parsePlayerArgs,
  toInteger,
} from './parse'
import type { ModifierKind, ParseOptions, ParsedArgs } from './parse'
import { renderList } from './backend'
import { searchSong, randomSong, songMeta } from './features/song'
import { songChart, songChartSummary } from './features/chart'
import { cardIllustration, searchCard } from './features/card'
import { stampImage } from './features/stamp'
import { gachaSimulate, searchGacha } from './features/gacha'
import { searchCharacter } from './features/character'
import { searchBand } from './features/band'
import { eventCutoff, eventRecommend, eventSongRanking, searchEvent } from './features/event'
import { keywordDelete, keywordUpload } from './features/keyword'
import { roomList, submitRoom } from './features/station'
import { friendDelete, friendList, friendUpload } from './features/friend'
import {
  b25,
  deckBuilder,
  playerBind,
  playerBindList,
  playerCard,
  playerUnbind,
  playerUse,
  searchPlayer,
  songRanking,
} from './features/player'
import type { PlayerTarget } from './features/player'
import {
  announcementDetail,
  announcementList,
  announcementUsage,
  subscribeAnnouncements,
  unsubscribeAnnouncements,
} from './features/announcement'
import type { SubscriptionContext } from './features/announcement'
import { backendStatus } from './features/health'
import { registerStubCommands } from './features/stub'
import { createStreamManager } from './stream/manager'
import type { StreamDeps } from './stream/manager'
import {
  createFileStore,
  createMemoryStore,
  defaultSubscriptionPath,
} from './stream/subscription'
import type { ChannelKey, SubscriptionStore } from './stream/subscription'

export const name = 'tomori-ournotes'

/** ctx.http 由 koishi 内置的 http 服务提供，声明依赖让 Koishi 先把它准备好 */
export const inject = ['http']

export interface Config {
  /** Tomori 后端地址（不带末尾斜杠也没关系） */
  backendURL: string
  /** 备用后端地址：只在「连不上」时按顺序重试，后端返回错误状态码不会触发切换 */
  backupURLs: string[]
  /** true 出 JPEG（快、体积小），false 出 PNG（清晰）。对应后端的 compress 字段 */
  compress: boolean
  /** 是否引用回复用户的消息 */
  reply: boolean
  /** 是否 @ 用户 */
  at: boolean
  /** 静态实体查询默认展示哪些服（用户显式写了服务器就按用户的来） */
  defaultServers: Server[]
  /** 单服（排行/玩家/抽卡/公告）查询的默认服务器 */
  defaultServer: Server
  /** 是否注册 Tomori 尚未实现的占位桩指令 */
  stubCommands: boolean
  /** 是否连接后端建立公告推流（关闭时订阅仍可登记，但收不到推送） */
  announcementStream: boolean
  /** 订阅文件的落盘路径；留空则用 <baseDir>/data/tomori-ournotes/subscriptions.json */
  subscriptionFile: string
  /** 单次请求超时（毫秒）。谱面渲染较慢，不要设太小 */
  requestTimeout: number
}

const serverSchema = Schema.union([
  Schema.const('tw').description('港澳台服'),
  Schema.const('jp').description('日服'),
  Schema.const('kr').description('韩服'),
  Schema.const('en').description('国际服'),
])

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    backendURL: Schema.string().default(DEFAULT_BACKEND_URL)
      .description('Tomori 后端地址。注意以你的 .env 里 PORT 为准（本插件对应的后端版本见上方分组说明）。'),
    backupURLs: Schema.array(Schema.string()).default([])
      .description('备用后端地址，仅在主地址连不上时按顺序重试。'),
    requestTimeout: Schema.number().default(120000).min(1000)
      .description('单次请求超时（毫秒）。谱面渲染要下载并绘制音符，首次可能较慢。'),
  }).description(`后端设置（${COMPATIBILITY_NOTE}）`),

  Schema.object({
    compress: Schema.boolean().default(true)
      .description('压缩图片：开启出 JPEG（更快、体积更小），关闭出 PNG（更清晰）。'),
    reply: Schema.boolean().default(true).description('是否引用回复用户的消息。'),
    at: Schema.boolean().default(true).description('是否 @ 用户。'),
    defaultServers: Schema.array(serverSchema).default([...SERVER_LIST])
      .description('静态实体查询（曲/卡/角色/乐团/活动/卡池/谱面/贴纸）默认展示的服务器，默认全部四服。'),
    defaultServer: serverSchema.default('tw')
      .description('单服查询（排行/玩家/抽卡/公告/活动榜）的默认服务器。'),
    stubCommands: Schema.boolean().default(true)
      .description('是否注册 Tomori 后端尚未实现的占位桩指令（lsycx、查试炼等）。'),
  }).description('查询设置'),

  Schema.object({
    announcementStream: Schema.boolean().default(true)
      .description('是否连接后端的公告推流（SSE）。关闭后仍可用「公告订阅」登记，但收不到推送。'),
    subscriptionFile: Schema.string().default('')
      .description('公告订阅的落盘路径，留空则用 <Koishi 目录>/data/tomori-ournotes/subscriptions.json。'),
  }).description('公告推流'),
])

/** 难度选项名 → 说明，用于 --help 展示 */
const DIFFICULTY_HINT = '难度可选 ez / nm / hd / ex，省略时按 ex 处理'
/** 谱面相关的通用修饰词说明 */
const CHART_ARGS_HINT = `可用修饰词：${DIFFICULTY_HINT}；镜像（-m）；速度7.5；服务器 ${SERVER_LIST.join('/')}`
/** 查贴纸的用法 */
const STAMP_USAGE = [
  '查询 Our Notes 贴纸（四服务器相互独立）',
  '查贴纸 <数字ID> —— 直出贴纸原图',
  '查贴纸 <关键词> [角色|团体] [服务器] —— 出搜索结果列表图（带 ID 与名称）',
  '查贴纸 全部 [服务器] —— 列出该服全部贴纸',
].join('\n')

/** 服务器相关的修饰词，绝大多数指令都认 */
const ALLOW_SERVER: readonly ModifierKind[] = ['server']

export function apply(ctx: Context, config: Config): void {
  /** 静态实体：用户没写就按配置的默认列表（默认四服） */
  const displayed = (explicit: Server[]): Server[] => pickDisplayedServers(explicit, config.defaultServers)
  /** 单服指令：用户没写就按配置的默认服 */
  const single = (explicit: Server[]): Server => pickSingleServer(explicit, config.defaultServer)

  // 启动时记一行配置摘要：出问题时先看这条，能立刻分清是「配置没生效」还是「后端的问题」
  ctx.logger('tomori').info(
    `已加载：后端 ${config.backendURL}（备用地址 ${config.backupURLs?.length ?? 0} 个）；`
    + `静态查询默认 ${displayed([]).join('、')}；单服默认 ${single([])}；`
    + `公告推流${config.announcementStream ? '开' : '关'}；占位桩${config.stubCommands ? '开' : '关'}`,
  )

  /**
   * 统一的「先解析、解析失败就回错误文案」包装。
   * 每个指令都走它，避免漏检 parseArgs 的失败分支。
   */
  function withArgs(
    raw: string | undefined,
    options: ParseOptions,
    run: (parsed: ParsedArgs) => Promise<h[]> | h[],
  ): Promise<h[]> | h[] {
    const parsed = parseArgs(raw, options)
    if (parsed.ok == false) {
      return [h.text(parsed.error)]
    }
    return run(parsed)
  }

  /** 交友登记用：把用户写的服务器归一，认不出来返回 undefined */
  function friendServer(token: string | undefined): Server | undefined {
    if (!token) return config.defaultServer ?? 'tw'
    return parseServerLoose(token)
  }

  /**
   * 关键词指令的三个位置参数（类型 / 实体 ID / 关键词）。
   * 校验不过时返回一句可直接发出的错误文案，过了返回解析结果。
   */
  function keywordArgs(
    type: string | undefined,
    entityId: string | undefined,
    keyword: string | undefined,
  ): { type: KeywordEntityType, id: number, keyword: string } | h[] {
    const parsed = parseKeywordType(type)
    if (!parsed) return [h.text(MESSAGES.invalidKeywordType)]

    const id = toInteger(entityId)
    if (id === undefined || id < 1) return [h.text(MESSAGES.invalidKeywordEntityId)]

    const text = (keyword ?? '').trim()
    if (!text) return [h.text(MESSAGES.missingKeyword)]
    if (text.length > MAX_KEYWORD_LENGTH) return [h.text(MESSAGES.keywordTooLong)]

    return { type: parsed, id, keyword: text }
  }

  /**
   * 玩家类指令（查玩家 / 发名片 / b25 / 组卡）的公共校验：
   * 只写了服务器、没写玩家 ID 时明确报错 —— 不写 ID 用的是绑定账号，
   * 服务器由绑定记录决定，后端会**静默忽略**显式服务器，插件不能装作接受。
   */
  function serverWithoutPlayerId(args: { playerId?: string }, parsed: ParsedArgs): h[] | undefined {
    if (!args.playerId && parsed.servers.length) return [h.text(MESSAGES.serverNeedsPlayerId)]
    return undefined
  }

  //=====公告推流=====
  const subscriptionPath = config.subscriptionFile?.trim()
    || defaultSubscriptionPath((ctx as { baseDir?: string }).baseDir ?? process.cwd())
  const store: SubscriptionStore = config.announcementStream
    ? createFileStore(subscriptionPath)
    : createMemoryStore()

  let manager: ReturnType<typeof createStreamManager> | undefined
  if (config.announcementStream) {
    manager = createStreamManager(store, streamDeps(ctx), { baseURL: config.backendURL })
    // 订阅文件要先读进来，否则启动时看着像「没人订阅」而一条连接都不建
    void store.load().then(() => manager?.start())
    ctx.on('dispose', () => manager?.stop())
  }

  const subscription: SubscriptionContext = {
    store,
    sync: () => manager?.sync(),
    enabled: config.announcementStream,
  }

  function sessionKey(session: { platform?: string, channelId?: string } | undefined): ChannelKey | undefined {
    if (!session?.platform || !session.channelId) return undefined
    return { platform: session.platform, channelId: session.channelId }
  }

  //=====歌曲=====//
  ctx.command('查曲 <text:text>', '从 Tomori 后端查询歌曲信息')
    .usage(`支持歌曲 ID 或名字（含模糊搜索）。命中单首出详情图，多首出列表图。\n服务器：${serverHint()}（默认全部四服）`)
    .example('查曲 诗超绊')
    .example('查曲 迷星叫 jp')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, parsed =>
      searchSong(ctx, config, parsed.text, displayed(parsed.servers))))

  ctx.command('随机曲 [text:text]', '随机来一首歌')
    .usage(`可选的筛选词会把随机范围限定在匹配的曲目里。\n服务器：${serverHint()}（取第一个作为主体）`)
    .example('随机曲')
    .example('随机曲 lv25 jp')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER, keepQuery: false }, parsed =>
      randomSong(ctx, config, parsed.text, displayed(parsed.servers))))

  ctx.command('曲效率 [text:text]', '查询歌曲 meta 效率排行')
    .alias('曲表', '分数表', '查询分数表')
    .usage([
      '一张图两榜：击奏live 与 自由live 各自效率最高的前 15 张谱面，四难度混排。',
      '数值与服务器无关（同一份谱面模拟数据），服务器只决定曲名/乐团的显示语言。',
      `服务器：${serverHint()}（默认全部四服，取第一个作为主体）`,
    ].join('\n'))
    .example('曲效率')
    .example('曲效率 tw jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      // 这个指令没有查询词，只认服务器；多写的词明确报出来，别默默吞掉
      if (parsed.text) return [h.text(`曲效率不接受查询词，只支持服务器，例如：曲效率 tw jp`)]
      return songMeta(ctx, config, displayed(parsed.servers))
    }))

  //=====谱面=====//
  // 这里没有用 .option('mirror')：贪心的 text 参数会把 -m 一起吞掉
  // （实测 options 拿不到值），所以镜像/难度/速度都由 parseArgs 自己剥。
  ctx.command('查谱面 <text:text>', '查询 Our Notes 官方谱面预览图')
    .alias('查谱')
    .usage(`支持歌曲 ID 或名字，${DIFFICULTY_HINT}。\n末尾加「镜像」或 -m 出镜像谱；「速度7.5」调流速（1~12）。\n服务器：${serverHint()}（默认全部四服）`)
    .example('查谱面 诗超绊 ex')
    .example('查谱面 100008 镜像')
    .example('查谱面 迷星叫 ex 速度7.5 jp')
    .action((_, text) => withArgs(text, { allow: ['difficulty', 'mirror', 'speed', ...ALLOW_SERVER] }, (parsed) => {
      if (!parsed.text) return [h.text('请提供歌曲 ID 或名字')]
      return songChart(ctx, config, parsed.text, parsed.difficultyId, parsed.mirror, parsed.noteSpeed, displayed(parsed.servers))
    }))

  ctx.command('谱面数据 <text:text>', '查询谱面数据摘要')
    .usage([
      '后端会返回完整谱面 JSON（含每个音符），这里只摘要展示；需要原始数据请直接调后端 /songChartData。',
      '歌名或 ID 都行；歌名命中多首时后端会回一句「请用 songId 精确指定」。',
      CHART_ARGS_HINT,
    ].join('\n'))
    .example('谱面数据 100008 ex')
    .example('谱面数据 诗超绊 ex -m')
    .action((_, text) => withArgs(text, { allow: ['difficulty', 'mirror', ...ALLOW_SERVER] }, (parsed) => {
      if (!parsed.text) return [h.text('请提供歌曲 ID 或名字')]
      return songChartSummary(ctx, config, parsed.text, parsed.difficultyId, parsed.mirror, displayed(parsed.servers))
    }))

  //=====卡牌 / 卡池=====//
  ctx.command('查卡 <text:text>', '查询卡面信息（角色卡与支援卡一起查）')
    .usage(`卡种可选 角色卡 / 支援卡，省略则两类一起查。\n服务器：${serverHint()}（默认全部四服）`)
    .example('查卡 高松灯')
    .example('查卡 高松灯 支援卡 jp')
    .action((_, text) => withArgs(text, { allow: ['cardKind', ...ALLOW_SERVER] }, parsed =>
      searchCard(ctx, config, parsed.text, 'auto', displayed(parsed.servers), parsed.cardKind)))

  ctx.command('查角色卡 <text:text>', '仅查询角色卡（成员卡）')
    .usage(`服务器：${serverHint()}（默认全部四服）`)
    .example('查角色卡 高松灯 jp')
    .action((_, text) => withArgs(text, { allow: ['cardKind', ...ALLOW_SERVER] }, parsed =>
      searchCard(ctx, config, parsed.text, 'member', displayed(parsed.servers))))

  ctx.command('查支援卡 <text:text>', '仅查询支援卡（留影）')
    .usage(`服务器：${serverHint()}（默认全部四服）`)
    .example('查支援卡 高松灯 jp')
    .action((_, text) => withArgs(text, { allow: ['cardKind', ...ALLOW_SERVER] }, parsed =>
      searchCard(ctx, config, parsed.text, 'support', displayed(parsed.servers))))

  ctx.command('查卡面 <cardId:string> [rest:text]', '查询卡面原图')
    .alias('卡面')
    .usage(`第一个参数是卡面 ID。卡种可选 角色卡 / 支援卡，省略时先按角色卡再按支援卡找。\n服务器：${serverHint()}（取第一个收录该卡的区域）`)
    .example('查卡面 1001')
    .example('查卡面 1001 支援卡 jp')
    .action((_, cardId, rest) => {
      const id = toInteger(cardId)
      if (id === undefined) return [h.text(MESSAGES.invalidCardId)]
      return withArgs(rest, { allow: ['cardKind', ...ALLOW_SERVER], keepQuery: false }, (parsed) => {
        // cardType 写错了要明确报错 —— 静默忽略会让用户以为在查支援卡，
        // 实际拿到的却是同 ID 的角色卡
        if (parsed.text) return [h.text(MESSAGES.invalidCardType)]
        return cardIllustration(ctx, config, id, displayed(parsed.servers), parsed.cardKind)
      })
    })

  ctx.command('查卡池 <text:text>', '查询卡池详情')
    .usage(`支持卡池 ID 或名字（名字多命中出卡池列表图）。\n服务器：${serverHint()}（默认全部四服）`)
    .example('查卡池 1 jp')
    .example('查卡池 夏日祭')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, (parsed) => {
      if (!parsed.text) return [h.text(MESSAGES.emptyText)]
      return searchGacha(ctx, config, parsed.text, displayed(parsed.servers))
    }))

  ctx.command('查贴纸 [text:text]', '查询官方贴纸原图或搜索贴纸')
    .usage(STAMP_USAGE)
    .example('查贴纸 1')
    .example('查贴纸 高松灯 角色 jp')
    .example('查贴纸 全部')
    .action((_, text) => {
      if (!(text ?? '').trim()) return [h.text(STAMP_USAGE)]
      return withArgs(text, { allow: ['stampScope', 'stampAll', ...ALLOW_SERVER], keepQuery: false }, (parsed) => {
        const servers = displayed(parsed.servers)
        if (parsed.stampAll) return stampImage(ctx, config, {}, servers)
        const id = toInteger(parsed.text)
        if (id !== undefined) return stampImage(ctx, config, { stampId: id }, servers)
        if (!parsed.text) {
          return [h.text(parsed.stampScope ? '只给了类别，请补上关键词，例如：查贴纸 高松灯 角色' : STAMP_USAGE)]
        }
        return stampImage(ctx, config, { text: parsed.text, scope: parsed.stampScope }, servers)
      })
    })

  ctx.command('抽卡模拟 [text:text]', '模拟卡池抽卡结果')
    .alias('卡池模拟', '抽卡')
    .usage(`第一个数字是次数（默认 10，上限 10000），第二个是卡池 ID 或卡池名（省略则用当前开放卡池）。\n服务器：${serverHint()}（取第一个作为主体）`)
    .example('抽卡模拟 10')
    .example('抽卡模拟 10 1 jp')
    .example('抽卡模拟 10 夏日祭')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseGachaArgs(parsed.text)
      if (!args) return [h.text(MESSAGES.invalidTimes)]
      return gachaSimulate(ctx, config, args.times, single(parsed.servers), args.gacha)
    }))

  //=====角色 / 活动=====//
  ctx.command('查角色 <text:text>', '查询角色信息')
    .usage(`服务器：${serverHint()}（默认全部四服）`)
    .example('查角色 千早爱音')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, parsed =>
      searchCharacter(ctx, config, parsed.text, displayed(parsed.servers))))

  ctx.command('查乐团 <text:text>', '查询乐团信息')
    .usage([
      '数字 ID 或名字都行；乐团也可以挂自定义关键词（见「新增关键词」）。',
      `服务器：${serverHint()}（默认全部四服）`,
    ].join('\n'))
    .example('查乐团 MyGO')
    .example('查乐团 1 jp')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, parsed =>
      searchBand(ctx, config, parsed.text, displayed(parsed.servers))))

  ctx.command('查活动 <text:text>', '查询活动信息')
    .usage([
      '只写一个服且该服自己有这个活动时出丰富详情图；多服请求、或那个服没收录时出多服组合表。',
      '按名字搜到多个活动时出活动列表图。',
      `服务器：${serverHint()}（默认全部四服）`,
    ].join('\n'))
    .example('查活动 活动名')
    .example('查活动 123 jp')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, parsed =>
      searchEvent(ctx, config, parsed.text, displayed(parsed.servers))))

  // 名次与活动 ID 都是纯数字，严格按位置认：第一个是名次、第二个是活动 ID
  ctx.command('活动歌榜 [text:text]', '查询该活动各乐曲榜')
    .alias('活动榜线')
    .usage([
      '每段列出该乐曲榜的名次（玩家名/综合力/出分），挑战演出活动一般有 3 首。',
      '第一个数字是**名次定位**：给 100 就画第 91~100 名那一段（每档 10 行），省略则是前十。',
      '活动写 ID 或名字（名字多命中出活动列表图），省略时取该服当前开放的活动；上游只追踪当前活动，历史活动查不到。',
      '取的是**活动内的挑战曲榜**，与「查排行」的曲子历史最高分榜不是一回事。',
      '想看各档分数线随时间的走势请用 ycx / ycxall，那是另一张折线图。',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('活动歌榜')
    .example('活动歌榜 100')
    .example('活动歌榜 100 1 jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseEventArgs(parsed.text, true)
      if (!args) return [h.text(MESSAGES.eventRankArgsOnly)]
      return eventSongRanking(ctx, config, single(parsed.servers), { rank: args.rank, id: args.id })
    }))

  ctx.command('ycx [text:text]', '查询活动榜线（单档位分数线折线图）')
    .usage([
      '各档分数线随时间的折线图。上游没有历史接口，数据由后端按小时采样攒，刚接入的活动可能还没有点。',
      `第一个数字是档位，可选 ${CUTOFF_TIERS.join(' / ')}，省略用 ${DEFAULT_CUTOFF_TIER}；`,
      '合不合法由后端按实际数据判定，不适配时会告诉你当前可用档位。',
      '活动写 ID 或名字，省略时取该服当前开放的活动。想看当前排行榜请用「活动歌榜」。',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('ycx')
    .example('ycx 100 1 jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseEventArgs(parsed.text, true)
      if (!args) return [h.text(MESSAGES.cutoffArgsOnly)]
      return eventCutoff(ctx, config, single(parsed.servers), {
        rank: args.rank ?? DEFAULT_CUTOFF_TIER,
        id: args.id,
      })
    }))

  ctx.command('ycxall [text:text]', '查询活动榜线（全部档位）')
    .usage([
      '与 ycx 同一张图，但不限定档位、把数据支持的档位都画上。',
      '活动写 ID 或名字（第一个数字就是活动 ID），省略时取该服当前开放的活动。',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('ycxall')
    .example('ycxall 1 jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseEventArgs(parsed.text, false)
      if (!args) return [h.text(MESSAGES.cutoffArgsOnly)]
      return eventCutoff(ctx, config, single(parsed.servers), { id: args.id })
    }))

  ctx.command('活动推荐 [text:text]', '查询该活动的推荐曲（按目标评级）')
    .alias('推荐曲')
    .usage([
      '一张图三截：击奏live、自由live 各按目标评级 SS/S/A/B 分四段，挑战live 单列一表。',
      '每段是所需综合力最低的谱面（只收 HD/EX），附局/小时与活动报酬估算。',
      '活动写 ID 或名字，省略时取该服当前开放的活动。',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('活动推荐')
    .example('活动推荐 123 jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseEventArgs(parsed.text, false)
      if (!args) return [h.text(MESSAGES.eventIdOnly)]
      return eventRecommend(ctx, config, single(parsed.servers), args.id)
    }))

  //=====排行 / 玩家=====//
  ctx.command('查排行 <text:text>', '查询该曲的排行榜（前十用户与出分）')
    .usage([
      '歌曲写 ID 或名字。这是单服数据，一次只查一个服；',
      '名字只在该服索引里搜索，多命中会出歌曲列表图。',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('查排行 100001 jp')
    .example('查排行 迷星叫 jp')
    .action((_, text) => withArgs(text, { allow: ALLOW_SERVER }, (parsed) => {
      if (!parsed.text) return [h.text(MESSAGES.emptyText)]
      return songRanking(ctx, config, parsed.text, single(parsed.servers))
    }))

  ctx.command('查玩家 [text:text]', '查询玩家档案（最爱卡面/名称/等级/应援数）')
    .alias('查账号')
    .usage([
      '玩家 ID 可省略：省略时用你在网页绑定的**默认账号**（见「玩家绑定」）。',
      '服务器跟玩家 ID 一起写：可省略，后端会按 ID 首位推断（2→港澳台服、3→国际服、4→韩服）；',
      '日服没有前缀规则，必须显式写 jp。不写 ID 时用的是绑定账号、服务器由绑定决定，这时写服务器会被拦下。',
      '有网页账号包时会再附一张账号包图（完成状态/道具/理论最高队伍），',
      '展示一律按网页的公开开关（绑定本人也一样）。',
      '默认数据源只能查到「在 StarMoe 已验证且设为公开」的账号，其余会回「该账号未公开或不存在」。',
    ].join('\n'))
    .example('查玩家 2000000000')
    .example('查玩家')
    .example('查玩家 2000000000 tw')
    .action(({ session }, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parsePlayerArgs(parsed.text)
      // 用 == false 而不是 !args.ok：实例的 tsconfig 常不开 strictNullChecks，
      // 那种模式下真值收窄对可辨识联合不生效（同 withArgs 里 parseArgs 的写法）
      if (args.ok == false) return [h.text(args.error)]
      const veto = serverWithoutPlayerId(args, parsed)
      if (veto) return veto
      // 写了玩家 ID 但没写服务器时整个不发这个字段，让后端按 ID 首位推断
      return searchPlayer(ctx, config, {
        playerId: args.playerId,
        server: parsed.servers[0],
        userId: session?.userId,
      })
    }))

  ctx.command('发名片 [text:text]', '发出玩家的名片原图（游戏里自己设计的那套）')
    .usage([
      '名片是玩家自己设计、当前正在用的那一套，最多 3 页；不指定页码时按页依次发全部原图。',
      '玩家 ID 可省略：省略时用你在网页绑定的默认账号。',
      '页码写成「页2」或「第2页」（也可 p2）——**不能写裸数字**，裸数字是玩家 ID。',
      `服务器跟玩家 ID 一起写（可省略，按 ID 首位推断；日服必须显式写 jp）。写法：${serverHint()}`,
    ].join('\n'))
    .example('发名片')
    .example('发名片 2000000000')
    .example('发名片 2000000000 页2')
    .example('发名片 3000000000 en')
    .action(({ session }, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parsePlayerArgs(parsed.text, { allowPage: true })
      if (args.ok == false) return [h.text(args.error)]
      const veto = serverWithoutPlayerId(args, parsed)
      if (veto) return veto
      return playerCard(ctx, config, {
        playerId: args.playerId,
        server: parsed.servers[0],
        userId: session?.userId,
      }, args.page)
    }))

  // 指令名不区分大小写（Koishi 会归一化），所以 B25 / b25 都能进
  ctx.command('b25 [text:text]', '查询 B25 计分榜（账号最强 25 张谱面）')
    .alias('查b25')
    .usage([
      '数据来自网页账号包（导入时算好的前 25 张：AP 记谱面等级、FC 记等级-1），不实时。',
      '玩家 ID 可省略：省略时用你在网页绑定的默认账号。',
      '**需要该账号包的歌曲公开**，隐藏时会提示去网页调整（绑定本人也一样）。',
      `服务器跟玩家 ID 一起写（可省略，按 ID 首位推断；日服必须显式写 jp）。写法：${serverHint()}`,
    ].join('\n'))
    .example('b25')
    .example('b25 2000000000')
    .action(({ session }, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parsePlayerArgs(parsed.text)
      if (args.ok == false) return [h.text(args.error)]
      const veto = serverWithoutPlayerId(args, parsed)
      if (veto) return veto
      return b25(ctx, config, {
        playerId: args.playerId,
        server: parsed.servers[0],
        userId: session?.userId,
      })
    }))

  ctx.command('组卡 [text:text]', '组卡工具：推荐队伍与收益/效率曲（与网页组卡器同逻辑）')
    .alias('组队', '配队')
    .usage([
      '不写模式时按「自动」：有进行中的活动就是活动模式（收益最大化），否则出最高综合力队伍 + 效率曲。',
      '活动模式出三块榜：自由live 混池 3 首、自由live 活动加成乐队 1 首、挑战live 活动挑战曲 1 首——',
      '都按「点数+道具相加最大」排，每行自带它自己的编队（图上用编号引用）。',
      '模式词：常规（最高综合力）/ 活动（活动收益）/ 自动。写「活动 123」或「活动123」可指定某期活动（往期也行）。',
      '玩家 ID 可省略：省略时用你在网页绑定的默认账号；裸数字是玩家 ID，紧随「活动」的数字才是活动 ID。',
      '**需要该账号包的卡片与道具公开**；谱面效率数据是备用源降级数据时（缺技能权重）不出图。',
      `服务器跟玩家 ID 一起写（可省略，按 ID 首位推断；日服必须显式写 jp）。写法：${serverHint()}`,
    ].join('\n'))
    .example('组卡')
    .example('组卡 活动')
    .example('组卡 活动 123')
    .example('组卡 常规 1234567890 jp')
    .action(({ session }, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      const args = parseDeckArgs(parsed.text)
      if (args.ok == false) return [h.text(args.error)]
      const veto = serverWithoutPlayerId(args, parsed)
      if (veto) return veto
      return deckBuilder(ctx, config, {
        playerId: args.playerId,
        server: parsed.servers[0],
        userId: session?.userId,
      }, { mode: args.mode, eventId: args.eventId })
    }))

  //=====绑定管理=====//
  // 绑定码在网页「我的账号」里按账号包生成（一次性、15 分钟有效）。
  // 绑定只做两件事：免输玩家 ID + 证明账号归属，**不解锁任何隐藏数据**。
  ctx.command('绑定玩家 <code:string>', '用网页生成的绑定码绑定游戏账号')
    .usage([
      '到网页「我的账号」给账号包填好玩家 ID、生成绑定码（8 位、一次性、15 分钟），把码发过来。',
      '一个 QQ 可绑多个账号，第一个自动设为默认；不传 ID 的查玩家/发名片/b25/组卡 都用默认账号。',
      '绑定只证明账号归属，群里的展示仍按网页的公开开关（绑定本人也一样）。',
      '依赖后端数据库（ENABLE_DB）与网页平台对接。',
    ].join('\n'))
    .example('绑定玩家 AB12CD34')
    .action(({ session }, code) => {
      const userId = session?.userId
      if (!userId) return [h.text(MESSAGES.sessionRequired)]
      const value = (code ?? '').trim()
      if (!value) return [h.text(MESSAGES.missingBindCode)]
      return playerBind(ctx, config, userId, value)
    })

  ctx.command('玩家绑定', '查看你已绑定的游戏账号（★ = 默认）')
    .alias('玩家状态', '玩家状态列表')
    .usage('列出本 QQ 绑定的全部游戏账号。解绑用「解除绑定」，切换默认用「默认玩家」。')
    .action(({ session }) => {
      const userId = session?.userId
      if (!userId) return [h.text(MESSAGES.sessionRequired)]
      return playerBindList(ctx, config, userId)
    })

  ctx.command('默认玩家 [target:string]', '切换默认绑定的游戏账号')
    .usage([
      '不传 ID 的查玩家 / 发名片 / b25 / 组卡 都用这个默认账号。',
      '序号看「玩家绑定」的列表（1 起）；1~3 位数字按序号算，更长的数字按玩家 ID 算。',
    ].join('\n'))
    .example('默认玩家 2')
    .example('默认玩家 2000000000')
    .action(({ session }, target) => {
      const userId = session?.userId
      if (!userId) return [h.text(MESSAGES.sessionRequired)]
      const selector = parseBindSelector(target)
      if (!selector) return [h.text(MESSAGES.bindSelectorUsage)]
      return playerUse(ctx, config, userId, selector)
    })

  ctx.command('解除绑定 [target:string]', '解绑一个游戏账号')
    .usage([
      '序号看「玩家绑定」的列表（1 起）；1~3 位数字按序号算，更长的数字按玩家 ID 算。',
      '默认账号被解绑时，最早绑定的那条自动升为默认。',
    ].join('\n'))
    .example('解除绑定 2')
    .example('解除绑定 2000000000')
    .action(({ session }, target) => {
      const userId = session?.userId
      if (!userId) return [h.text(MESSAGES.sessionRequired)]
      const selector = parseBindSelector(target)
      if (!selector) return [h.text(MESSAGES.bindSelectorUsage)]
      return playerUnbind(ctx, config, userId, selector)
    })

  //=====公告=====//
  ctx.command('公告列表 [text:text]', '查询该服的游戏公告列表图')
    .usage(`服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`)
    .example('公告列表')
    .example('公告列表 jp')
    .action((_, text) => withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
      if (parsed.text) return [h.text(`参数无法识别，可用服务器：${serverHint()}`)]
      return announcementList(ctx, config, single(parsed.servers))
    }))

  ctx.command('公告订阅 <text:text>', '订阅本会话的公告推流')
    .usage(`公告新增或修改时会自动推到本会话。可写多个服务器累积订阅。\n服务器：${serverHint()}`)
    .example('公告订阅 tw')
    .example('公告订阅 tw jp')
    .action(({ session }, text) => {
      const key = sessionKey(session)
      if (!key) return [h.text(MESSAGES.sessionRequired)]
      return withArgs(text, { allow: ALLOW_SERVER, keepQuery: false }, (parsed) => {
        if (!parsed.servers.length) return [h.text(MESSAGES.missingSubscribeServer)]
        return subscribeAnnouncements(subscription, key, normalizeServerList(parsed.servers))
      })
    })

  ctx.command('公告退订 [text:text]', '退订本会话的公告推流')
    .usage('不带服务器则退订全部。')
    .example('公告退订')
    .example('公告退订 jp')
    .action(({ session }, text) => {
      const key = sessionKey(session)
      if (!key) return [h.text(MESSAGES.sessionRequired)]
      return withArgs(text ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) =>
        unsubscribeAnnouncements(subscription, key, parsed.servers.length ? normalizeServerList(parsed.servers) : undefined))
    })

  // 「公告」是参考项目那套重载写法，保留以兼容习惯用法：
  //   公告 <服务器>        → 订阅
  //   公告 关闭 [服务器]   → 退订
  //   公告 <数字ID> [服务器] → 查详情
  ctx.command('公告 [first:string] [rest:text]', '查询公告详情 / 订阅公告推流')
    .usage([
      '公告 <公告ID> [服务器] —— 查询该条公告详情图',
      '公告 最新 [服务器] —— 查询该服最新一条公告的详情图（写成 "-1" 也行，但裸 -1 会被 Koishi 当选项吞掉）',
      '公告订阅 <服务器…> —— 订阅本会话的公告推流（等价于 公告 <服务器>）',
      '公告退订 [服务器…] —— 退订（等价于 公告 关闭 [服务器]）',
      `服务器：${serverHint()}（默认 ${config.defaultServer ?? 'tw'}）`,
    ].join('\n'))
    .example('公告 23')
    .example('公告 23 jp')
    .example('公告 最新')
    .example('公告 tw')
    .example('公告 关闭')
    .action(({ session }, first, rest) => {
      const key = sessionKey(session)
      if (!key) return [h.text(MESSAGES.sessionRequired)]
      const arg = (first ?? '').trim()
      if (!arg) return announcementUsage()

      if (SUBSCRIPTION_CLOSE_KEYWORDS.includes(arg.toLowerCase())) {
        return withArgs(rest ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) =>
          unsubscribeAnnouncements(subscription, key, parsed.servers.length ? normalizeServerList(parsed.servers) : undefined))
      }
      
      let id: number | undefined = -1
      if (arg == "-1" || arg == "new" || arg == "最新"){
        id = -1
      }else{
        id = toInteger(arg)
      }
      if (id !== undefined) {
        return withArgs(rest ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) =>
          announcementDetail(ctx, config, String(id), single(parsed.servers)))
      }

      const server = parseServerLoose(arg)
      if (server) {
        return withArgs(rest ?? '', { allow: ALLOW_SERVER, keepQuery: false }, (parsed) =>
          subscribeAnnouncements(subscription, key, normalizeServerList([server, ...parsed.servers])))
      }

      return announcementUsage()
    })

  //=====车站=====//
  ctx.command('车来', '查看当前车站列表')
    .alias('ycm', '有车吗')
    .action(() => roomList(ctx, config))

  ctx.command('上传车牌 <raw:text>', '上传并公开车牌')
    .usage('第一个参数是 5-7 位房间号，后面可以跟任意备注。房号重复提交等于刷新有效期。')
    .example('上传车牌 1234567 上车')
    .action(({ session }, raw) => {
      if (!raw) return [h.text(MESSAGES.missingRoomNumber)]
      if (!session) return [h.text(MESSAGES.sessionRequired)]
      return submitRoom(ctx, config, raw, fromSession(session))
    })

  //=====交友（Tomori 独有）=====//
  ctx.command('交友登记 <playerId:string> [server:string]', '登记 / 更新你的交友名片')
    .usage(`一人一条，重复登记会覆盖。服务器：${serverHint()}，也认「日服」「国际服」「韩服」这类写法。`)
    .example('交友登记 9876543210')
    .example('交友登记 9876543210 jp')
    .action(({ session }, playerId, server) => {
      if (!session) return [h.text(MESSAGES.sessionRequired)]
      const parsed = friendServer(server)
      if (server && !parsed) return [h.text(`服务器只支持 ${serverHint()}`)]
      return friendUpload(ctx, config, playerId, parsed as Server, fromSession(session))
    })

  ctx.command('解除交友', '删除你的交友名片')
    .alias('删除交友')
    .action(({ session }) => {
      if (!session) return [h.text(MESSAGES.sessionRequired)]
      return friendDelete(ctx, config, fromSession(session))
    })

  ctx.command('交友列表', '查看交友列表图')
    .action(() => friendList(ctx, config))

  //=====关键词（Tomori 独有）=====//
  // 给角色/角色卡/支援卡/歌曲挂一个别名，关键词会参与模糊搜索
  ctx.command('新增关键词 <type:string> <entityId:string> [keyword:text]', '给角色/角色卡/支援卡/歌曲挂一个检索别名')
    .usage([
      '关键词参与模糊搜索，之后「查曲 那个外号」就能搜到。',
      '类型：角色 / 角色卡 / 支援卡 / 歌曲',
      '后端会查重：同一实体上重复、或与现有实体名/别名重合都会被拒绝。',
      '依赖后端数据库，未启用时会回「服务器未启用数据库」。',
    ].join('\n'))
    .example('新增关键词 歌曲 100001 迷星叫')
    .action(({ session }, type, entityId, keyword) => {
      if (!session) return [h.text(MESSAGES.sessionRequired)]
      const parsed = keywordArgs(type, entityId, keyword)
      if (Array.isArray(parsed)) return parsed
      return keywordUpload(ctx, config, parsed.type, parsed.id, parsed.keyword, fromSession(session))
    })

  ctx.command('删除关键词 <type:string> <entityId:string> [keyword:text]', '删除自己上传的关键词')
    .usage([
      '只能删自己上传的（后端按你的用户 ID 过滤）。',
      '类型：角色 / 角色卡 / 支援卡 / 歌曲',
    ].join('\n'))
    .example('删除关键词 歌曲 100001 迷星叫')
    .action(({ session }, type, entityId, keyword) => {
      if (!session) return [h.text(MESSAGES.sessionRequired)]
      const parsed = keywordArgs(type, entityId, keyword)
      if (Array.isArray(parsed)) return parsed
      return keywordDelete(ctx, config, parsed.type, parsed.id, parsed.keyword, fromSession(session))
    })

  //=====运维=====//
  ctx.command('后端状态', '查看 Tomori 后端的连通性与版本')
    .alias('tomori状态')
    .action(() => backendStatus(ctx, config))

  //=====占位桩=====//
  if (config.stubCommands) registerStubCommands(ctx, config)

  //=====消息设置=====//
  // 在真正发出前给消息加上「引用回复」和「@」。
  // 注意钩子签名：第一个参数是「即将发出的会话」（elements 已填好待发内容），
  // 第二个参数 options.session 才是触发回复的用户会话。
  // 返回值必须保持 undefined —— 返回 true 会取消这次发送。
  //
  // 公告推流走 bot.sendMessage，不经过这个钩子，所以推送不会被莫名加上引用/@。
  ctx.before('send', (session, options) => {
    if (!session.elements?.length) return
    const source = options.session
    if (config.at) {
      const id = source?.userId
      if (id) session.elements.unshift(h.at(id))
    }
    if (config.reply) {
      const messageId = source?.messageId
      if (messageId) session.elements.unshift(h.quote(messageId))
    }
  })
}

/**
 * 推流的默认依赖。
 *
 * 单独抽出来是为了让 stream/manager 完全不知道 ctx 的存在 ——
 * 单测里换掉这几个依赖就能把整条链路跑通，不需要真后端，也不用 mock 平台适配器。
 */
function streamDeps(ctx: Context): StreamDeps {
  return {
    async open(url, signal) {
      // SSE 是长连接：必须显式 timeout:0，否则会被 http 服务的超时（或 koishi.yml 里
      // request.timeout）掐断。validateStatus 也要接管，免得 4xx 直接抛、拿不到状态码。
      const response = await (ctx.http as unknown as (
        url: string,
        options: Record<string, unknown>,
      ) => Promise<{ status: number, data: unknown }>)(url, {
        method: 'GET',
        responseType: 'stream',
        headers: { accept: 'text/event-stream' },
        signal,
        timeout: 0,
        validateStatus: () => true,
      })
      return { status: response.status, data: (response.data ?? null) as ReadableStream<Uint8Array> | null }
    },
    async send(target, elements) {
      const bot = ctx.bots.find(b => b.platform === target.platform)
      if (!bot) throw new Error(`没有在线的 ${target.platform} bot`)
      await bot.sendMessage(target.channelId, elements)
    },
    render(items) {
      return renderList(ctx, [...items])
    },
    log(level, message) {
      try {
        ctx.logger('tomori')[level](message)
      } catch {
        // 测试夹具里的 ctx 可能没有 logger，忽略
      }
    },
    schedule(ms, fn) {
      return ctx.setTimeout(fn, ms)
    },
  }
}
