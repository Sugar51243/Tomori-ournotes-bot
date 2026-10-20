/**
 * 指令入参的解析与小工具。
 *
 * 这里的函数都是纯函数（不碰 ctx、不发请求），便于单测覆盖边界情况。
 *
 * ## 为什么是「逐 token 分类」而不是「从尾部剥离」
 *
 * 早期实现按「从尾部反复剥掉修饰词」来解析，对 `诗超绊 ex 镜像` 这种写法够用，
 * 但遇到服务器词夹在中间就会错：
 *
 * | 输入 | 尾部剥离 | 逐 token 分类 |
 * | --- | --- | --- |
 * | `查曲 tw jp` | `servers:[tw], text:'jp'` —— 丢了一个服，还拿 "jp" 去搜 | `servers:[tw,jp], text:''` |
 * | `查谱面 jp 100008` | `text:'jp 100008'`，变成关键词搜索而不是按 ID 查 | 走 ID 路径 |
 *
 * 所以改成参考项目（小生物v2）那样：**每个 token 单独判定**属于哪一类修饰词，
 * 认不出来的一律当查询词，与出现位置无关。
 */
import {
  CARD_KIND_ALIASES,
  DECK_MODE_ALIASES,
  DEFAULT_DIFFICULTY_ID,
  DIFFICULTY_ALIASES,
  DIFFICULTY_SUFFIXES,
  KEYWORD_TYPE_ALIASES,
  MESSAGES,
  NOTE_SPEED_MAX,
  NOTE_SPEED_MIN,
  STAMP_ALL_KEYWORDS,
  STAMP_SCOPE_ALIASES,
} from './config'
import type { CardKind, DeckMode, KeywordEntityType, StampScope } from './config'
import { parseServer } from './server'
import type { Server } from './server'

/** 本指令认哪些修饰词（不开启的类别一律当查询词） */
export type ModifierKind =
  | 'difficulty'
  | 'mirror'
  | 'speed'
  | 'server'
  | 'cardKind'
  | 'stampScope'
  | 'stampAll'

export interface ParseOptions {
  /** 允许从 token 里识别出来的修饰词类别，默认一个都不认 */
  allow?: readonly ModifierKind[]
  /**
   * 是否要求留下查询词（默认 true）。
   * 剥完一个查询词都不剩时：true → 单 token 输入回退成原文当查询词（保住 `查曲 ex` 的旧行为）；
   * false → text 为空串（随机曲/曲表/贴纸/抽卡/公告 这些指令合法）。
   */
  keepQuery?: boolean
}

export interface ParsedArgs {
  /** 去掉全部修饰词后剩下的查询词 */
  text: string
  /**
   * 用户显式写的服务器（按 SERVER_LIST 顺序、已去重）。
   * **空数组表示「用户没说」** —— 解析器不塞默认值，由调用方决定
   * （全四服 / [默认服] / 干脆不发这个字段，例如查玩家）。
   */
  servers: Server[]
  difficultyId: number
  /** 用户是否显式写了难度 */
  explicitDifficulty: boolean
  /** 用户要求镜像谱面 */
  mirror: boolean
  /** 用户指定了谱面流速 */
  noteSpeed?: number
  /** 用户指定了卡片种类 */
  cardKind?: CardKind
  /** 用户限定了贴纸关键词的匹配维度 */
  stampScope?: StampScope
  /** 用户要求列出全部贴纸 */
  stampAll: boolean
}

export type ParseResult =
  | ({ ok: true } & ParsedArgs)
  | { ok: false; error: string }

/** 镜像修饰词。`-m` 之所以要自己剥：贪心的 text 参数会把 Koishi 的选项一起吞掉。 */
const MIRROR_TOKENS = new Set(['镜像', 'mirror', '-m'])
/** 流速的粘连形态：速度7.5 / 流速7.5 / speed7.5 */
const SPEED_GLUED = /^(?:速度|流速|speed)(\d+(?:\.\d+)?)$/i
/** 与之等价的独立 token 形态：`速度 7.5` */
const SPEED_BARE = new Set(['速度', '流速', 'speed'])
/** Our Notes 没有 special；写了就明确报错，而不是当成 difficultyId 4 发出去必然 400 */
const SPECIAL_TOKENS = new Set(['sp', 'special'])
const NUMBER_TOKEN = /^\d+(?:\.\d+)?$/

function isAllowed(allow: readonly ModifierKind[], kind: ModifierKind): boolean {
  return allow.includes(kind)
}

/**
 * 解析一条指令的参数。
 *
 * 例：`parseArgs('诗超绊 ex 镜像', { allow: ['difficulty', 'mirror'] })`
 * → `{ ok: true, text: '诗超绊', difficultyId: 3, mirror: true, ... }`
 */
export function parseArgs(raw: string | undefined, options: ParseOptions = {}): ParseResult {
  const input = (raw ?? '').trim()
  const allow = options.allow ?? []
  const keepQuery = options.keepQuery !== false
  const tokens = input ? input.split(/\s+/).filter(Boolean) : []

  const textTokens: string[] = []
  const servers: Server[] = []
  let difficultyId = DEFAULT_DIFFICULTY_ID
  let explicitDifficulty = false
  let mirror = false
  let noteSpeed: number | undefined
  let cardKind: CardKind | undefined
  let stampScope: StampScope | undefined
  let stampAll = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()

    if (isAllowed(allow, 'mirror') && MIRROR_TOKENS.has(lower)) {
      mirror = true
      continue
    }

    if (isAllowed(allow, 'difficulty')) {
      if (SPECIAL_TOKENS.has(lower)) {
        return { ok: false, error: MESSAGES.unsupportedSpecial }
      }
      const id = DIFFICULTY_ALIASES[lower]
      if (id !== undefined) {
        difficultyId = id
        explicitDifficulty = true
        continue
      }
    }

    if (isAllowed(allow, 'speed')) {
      const glued = SPEED_GLUED.exec(token)
      if (glued) {
        const value = Number(glued[1])
        if (!(value >= NOTE_SPEED_MIN && value <= NOTE_SPEED_MAX)) {
          return { ok: false, error: MESSAGES.invalidNoteSpeed }
        }
        noteSpeed = value
        continue
      }
      // 独立写法：`速度 7.5`。孤立的「速度」后面没有数字时不算修饰词，落回查询词
      if (SPEED_BARE.has(lower) && i + 1 < tokens.length && NUMBER_TOKEN.test(tokens[i + 1])) {
        const value = Number(tokens[i + 1])
        if (!(value >= NOTE_SPEED_MIN && value <= NOTE_SPEED_MAX)) {
          return { ok: false, error: MESSAGES.invalidNoteSpeed }
        }
        noteSpeed = value
        i++
        continue
      }
    }

    if (isAllowed(allow, 'server')) {
      const server = parseServer(token)
      if (server) {
        if (!servers.includes(server)) servers.push(server)
        continue
      }
    }

    if (isAllowed(allow, 'cardKind')) {
      const kind = CARD_KIND_ALIASES[lower] ?? CARD_KIND_ALIASES[token]
      if (kind) {
        cardKind = kind
        continue
      }
    }

    // 「全部」要在范围之前判：否则 all 会被范围表吃掉，变成「只在 all 范围里搜」
    if (isAllowed(allow, 'stampAll') && STAMP_ALL_KEYWORDS.includes(lower)) {
      stampAll = true
      continue
    }

    if (isAllowed(allow, 'stampScope')) {
      const scope = STAMP_SCOPE_ALIASES[lower] ?? STAMP_SCOPE_ALIASES[token]
      if (scope) {
        stampScope = scope
        continue
      }
    }

    textTokens.push(token)
  }

  let text = textTokens.join(' ').trim()

  if (!text && keepQuery && tokens.length === 1) {
    // 只输了一个词，而它恰好是修饰词（`ex`、`镜像`）：当成查询词，
    // 否则用户既搜不到东西也拿不到「缺查询词」的提示
    text = input
    difficultyId = DEFAULT_DIFFICULTY_ID
    explicitDifficulty = false
    mirror = false
    noteSpeed = undefined
  }

  // 兼容没有空格粘连的写法（"诗超绊ex"）：只有当这个 token 还有前缀时才剥
  if (text) {
    const parts = text.split(' ')
    const last = parts[parts.length - 1]
    if (last && last.length > 2) {
      const tail = last.slice(-2).toLowerCase()
      const id = DIFFICULTY_ALIASES[tail]
      if (SPECIAL_TOKENS.has(tail)) {
        return { ok: false, error: MESSAGES.unsupportedSpecial }
      }
      if (id !== undefined && (DIFFICULTY_SUFFIXES as readonly string[]).includes(tail)) {
        difficultyId = id
        explicitDifficulty = true
        parts[parts.length - 1] = last.slice(0, -2)
        text = parts.join(' ').trim()
      }
    }
  }

  return {
    ok: true,
    text,
    // 按固定顺序给出，便于断言与稳定出图
    servers: (['tw', 'jp', 'kr', 'en'] as Server[]).filter(s => servers.includes(s)),
    difficultyId,
    explicitDifficulty,
    mirror,
    noteSpeed,
    cardKind,
    stampScope,
    stampAll,
  }
}

/** 把用户写法（角色 / 角色卡 / 支援卡 / 歌曲）归一到 /keyword/* 的 entityType */
export function parseKeywordType(token: string | undefined): KeywordEntityType | undefined {
  if (!token) return undefined
  const trimmed = token.trim()
  return KEYWORD_TYPE_ALIASES[trimmed.toLowerCase()] ?? KEYWORD_TYPE_ALIASES[trimmed]
}

/**
 * 玩家类指令（查玩家 / 发名片 / b25）的参数：`[玩家ID] [页码]`。
 *
 * 玩家 ID 可省略 —— 省略表示「用绑定的默认账号」（由后端按 userId 取）。
 * 玩家 ID 只认**裸数字**，像别处一样不去猜：多写一个数字就报错，不会默默取一个。
 */
export interface PlayerArgs {
  /** 玩家 ID（纯数字串）；省略 = 用绑定里的默认账号 */
  playerId?: string
  /** 名片页码（只有发名片收）；省略 = 全部页 */
  page?: number
}

export type PlayerArgsResult = ({ ok: true } & PlayerArgs) | { ok: false; error: string }

/** 页码的写法：页2 / 第2页 / p2 / page2（「页」单独出现算写法不完整） */
const PAGE_PATTERNS: readonly RegExp[] = [/^第?(\d*)页$/, /^页(\d*)$/, /^p(?:age)?(\d*)$/i]

/** 匹配到页码写法时返回数字；写法不完整（没有数字）返回 undefined —— 由调用方按错误处理 */
function matchPageToken(token: string): { matched: true; value: number | undefined } | { matched: false } {
  for (const pattern of PAGE_PATTERNS) {
    const result = pattern.exec(token)
    if (result) {
      const digits = result[1] ?? ''
      return { matched: true, value: digits ? Number(digits) : undefined }
    }
  }
  return { matched: false }
}

/**
 * 解析「查玩家 / 发名片 / b25」的查询词（服务器已被 parseArgs 剥走）。
 *
 * `allowPage` 只有发名片开 —— 页码不能写成裸数字（那样与玩家 ID 撞车），
 * 必须写成 `页2`/`第2页`/`p2`。
 */
export function parsePlayerArgs(text: string | undefined, options: { allowPage?: boolean } = {}): PlayerArgsResult {
  const trimmed = (text ?? '').trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []

  let playerId: string | undefined
  let page: number | undefined

  for (const token of tokens) {
    if (options.allowPage) {
      const pageToken = matchPageToken(token)
      if (pageToken.matched) {
        if (page !== undefined) return { ok: false, error: MESSAGES.playerPageOnlyOne }
        if (pageToken.value === undefined || pageToken.value < 1) {
          return { ok: false, error: MESSAGES.invalidPlayerPage }
        }
        page = pageToken.value
        continue
      }
    }
    if (/^\d+$/.test(token)) {
      if (playerId !== undefined) return { ok: false, error: MESSAGES.playerIdOnlyOne }
      playerId = token
      continue
    }
    return { ok: false, error: MESSAGES.invalidPlayerId }
  }

  return { ok: true, playerId, page }
}

/**
 * 组卡（/deckBuilder）的参数：`[玩家ID] [常规|活动[ID]|自动] [服务器]`。
 *
 * 数字分两种，靠「活动」这个词区分，不做任何猜测：
 * - 紧跟在「活动」后面的数字（`活动 123` 或粘连的 `活动123`）是**活动 ID**；
 * - 其余裸数字是**玩家 ID**（最多一个；省略 = 用绑定的默认账号）。
 */
export interface DeckArgs {
  playerId?: string
  /** 活动 ID；给了就等于活动模式（后端也会强制），不写则按 mode */
  eventId?: number
  /** 用户显式写的模式；不写由后端按 auto 处理 */
  mode?: DeckMode
}

export type DeckArgsResult = ({ ok: true } & DeckArgs) | { ok: false; error: string }

export function parseDeckArgs(text: string | undefined): DeckArgsResult {
  const trimmed = (text ?? '').trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []

  const args: DeckArgs = {}

  const setMode = (mode: DeckMode): boolean => {
    // 两个模式词互相打架（组卡 常规 活动）时不猜，报用法
    if (args.mode !== undefined && args.mode !== mode) return false
    args.mode = mode
    return true
  }
  const setEventId = (value: number): boolean => {
    if (args.eventId !== undefined) return false
    args.eventId = value
    return true
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()

    const gluedEvent = /^活动(\d+)$/.exec(token)
    if (gluedEvent) {
      if (!setMode('event') || !setEventId(Number(gluedEvent[1]))) {
        return { ok: false, error: MESSAGES.deckArgsUsage }
      }
      continue
    }

    const mode = DECK_MODE_ALIASES[lower] ?? DECK_MODE_ALIASES[token]
    if (mode) {
      if (!setMode(mode)) return { ok: false, error: MESSAGES.deckArgsUsage }
      // 「活动 123」：紧随其后的裸数字是这个活动的 ID
      if (mode === 'event' && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        if (!setEventId(Number(tokens[i + 1]))) return { ok: false, error: MESSAGES.deckArgsUsage }
        i++
      }
      continue
    }

    if (/^\d+$/.test(token)) {
      if (args.playerId !== undefined) return { ok: false, error: MESSAGES.deckArgsUsage }
      args.playerId = token
      continue
    }

    return { ok: false, error: MESSAGES.deckArgsUsage }
  }

  return { ok: true, ...args }
}

/**
 * 「默认玩家 / 解除绑定」的账号选择：**1~3 位数字按绑定列表序号**，更长的按玩家 ID。
 *
 * 两种写法都是裸数字，只能这样分：游戏 ID 实打实是 9~10 位（后端允许 1~15），
 * 序号则不会超过两位数。看列表用「玩家绑定」，每行前面就有序号。
 */
export function parseBindSelector(token: string | undefined): { playerId?: string; index?: number } | undefined {
  const value = (token ?? '').trim()
  if (!value) return {}
  if (/^\d{1,3}$/.test(value)) {
    const index = Number(value)
    return index >= 1 ? { index } : undefined
  }
  if (/^\d{4,19}$/.test(value)) return { playerId: value }
  return undefined
}

export interface EventArgs {
  /** 名次 / 榜线档位：**第一个**数字；`ycxall` 不收档位 */
  rank?: number
  /** 活动 ID（数字）或活动名（文本）；不写表示取该服当前开放的活动 */
  id?: string | number
}

/**
 * 解析「名次/档位 + 活动」（`活动歌榜` / `ycx` / `ycxall` / `活动推荐`）。
 *
 * 规则与参考实现 `小生物v2/event.py` 的 `_parse_event_parameters` 一致：
 * - 数字按**出现顺序**排队：`allowTier` 时第一个是名次/档位，下一个是活动 ID
 * - 其余 token 拼成活动名（后端只在该服索引里模糊搜索，多命中出活动列表图）
 * - 活动 ID 与活动名同时出现、或多出数字，一律算非法 —— 不去猜用户想查哪个
 *
 * 名次之所以按位置而不是「落在档位表里就算名次」：后者会让
 * `ycx 100 1` 与 `ycx 1 100` 里两个数字的含义随取值对调，用户没法从写法上判断。
 * 代价是 `ycx 1` 会被当成「名次 1」而不是「活动 1」—— 后端对不适配的名次
 * 会回一句「当前可用档位: …」，照着改即可，比含义漂移好。
 *
 * @param allowTier `ycxall` 传 false —— 它画全部档位，第一个数字就是活动 ID
 */
export function parseEventArgs(text: string | undefined, allowTier: boolean): EventArgs | undefined {
  const trimmed = (text ?? '').trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []

  const numbers: number[] = []
  const words: string[] = []
  for (const token of tokens) {
    const value = toInteger(token)
    if (value === undefined) words.push(token)
    else numbers.push(value)
  }

  let rank: number | undefined
  if (allowTier && numbers.length > 0) rank = numbers.shift()

  if (numbers.length > 1) return undefined
  if (numbers.length === 1 && words.length > 0) return undefined

  const id: string | number | undefined = numbers.length === 1 ? numbers[0] : words.join(' ')

  return { rank, id: id === '' ? undefined : id }
}

export interface GachaArgs {
  /** 抽卡次数（默认 10，上限由后端判定） */
  times: number
  /** 卡池 ID（数字）或卡池名（文本）；不写表示取该服当前开放的卡池 */
  gacha?: string | number
}

/**
 * 解析「抽卡模拟」的入参：`[次数] [卡池 ID 或卡池名]`。
 *
 * 与参考实现 `小生物v2/card.py` 的 `gacha_simulate` 同规则 —— 数字按出现顺序排队
 * （第一个是次数、第二个是卡池 ID），非数字 token 拼成卡池名，两者不能同时给：
 * `抽卡 10 1`、`抽卡 10 夏日祭`、`抽卡 夏日祭` 都合法，`抽卡 1 2 3` 与
 * `抽卡 10 夏日祭 2` 算参数错误（不猜）。
 */
export function parseGachaArgs(text: string | undefined): GachaArgs | undefined {
  const trimmed = (text ?? '').trim()
  const tokens = trimmed ? trimmed.split(/\s+/) : []

  const numbers: number[] = []
  const words: string[] = []
  for (const token of tokens) {
    const value = toInteger(token)
    if (value === undefined) words.push(token)
    else numbers.push(value)
  }

  if (numbers.length > 2) return undefined
  if (numbers.length > 1 && words.length > 0) return undefined

  const times = numbers.length > 0 ? numbers[0] : 10
  if (times < 1) return undefined

  const gacha: string | number | undefined = numbers.length > 1 ? numbers[1] : words.join(' ')
  return { times, gacha: gacha === '' ? undefined : gacha }
}

export interface RoomInput {
  /** 原始房间号字符串（保留前导 0，用于 rawMessage） */
  room: string
  /** 送给后端的数字房间号（后端校验 isInt，只能是数字） */
  number: number
  /** 用户附带的备注 */
  note: string
  /** 用户输入的完整原文 */
  raw: string
}

/**
 * 解析「上传车牌 1234567 上车」的入参。
 *
 * 房间号长度：**5-7 位数字**。Our Notes 用 7 位房间号；保留 5/6 位是为了
 * 兼容旧房间号（放宽而非收紧，避免把仍然有效的 6 位房号拒掉）。
 *
 * 刻意**不做**参考项目里的「取左侧 N 位数字」截断：那样多写的位数会被悄悄
 * 截断，把错误的房号发出去。这里要求开头就是完整的 5-7 位数字，
 * 后面必须紧跟空白或结束，否则视为非法（返回 undefined）。
 */
export function parseRoomInput(raw: string): RoomInput | undefined {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return undefined
  const match = /^(\d{5,7})(?=\s|$)\s*(.*)$/.exec(trimmed)
  if (!match) return undefined
  return {
    room: match[1],
    number: Number(match[1]),
    note: match[2].trim(),
    raw: trimmed,
  }
}

/** 纯数字字符串（后端的 songId / gachaId / stampId / cardId 都要求整数） */
export function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}
