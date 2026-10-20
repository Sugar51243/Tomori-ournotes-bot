/**
 * 游戏区域（服务器）。
 *
 * 后端有四个区域，内部统一用短码 `tw/jp/kr/en`。注意上游有三套并存的命名，
 * 后端已在自己的 `types/Server.ts` 里收口，插件这边只需要认「短码 + 常见别名」：
 * - `hk-tw-mo` 是**清单键**，后端拿它当 `tw` 的别名（老 tsugu 客户端与历史交友记录都这么传）
 * - master 表路径段与素材区域段都是 `tw`
 *
 * 交友的 `server` 也用这一套（后端的 `isFriendServer` 就是 `normalizeServer`），
 * 所以这里不再单独维护 `FriendServer`。
 */

export type Server = 'tw' | 'jp' | 'kr' | 'en'

/** 固定顺序：出图时的行序、默认查询顺序、订阅列表的展示顺序都依赖它 */
export const SERVER_LIST: readonly Server[] = ['tw', 'jp', 'kr', 'en']

export const SERVER_DISPLAY: Record<Server, string> = {
  tw: '港澳台服',
  jp: '日服',
  kr: '韩服',
  en: '国际服',
}

/** 用户可能输入的写法（小写比较）→ 短码 */
const SERVER_ALIASES: Record<string, Server> = {
  tw: 'tw', 'hk-tw-mo': 'tw', hk: 'tw', hktwmo: 'tw',
  港澳台服: 'tw', 港澳台: 'tw', 港台服: 'tw', 台服: 'tw', 繁中服: 'tw', 繁中: 'tw',
  jp: 'jp', 日服: 'jp', 日本服: 'jp',
  kr: 'kr', 韩服: 'kr', 韩国服: 'kr',
  en: 'en', 国际服: 'en', 全球服: 'en', 国际: 'en',
}

/**
 * 单字「日」「韩」歧义太大（歌名/卡名里都可能出现），
 * 所以只在**服务器专用参数**上宽松认（公告的服务器参数），不参与通用的 token 分类。
 */
const SERVER_ALIASES_LOOSE: Record<string, Server> = {
  日: 'jp',
  韩: 'kr',
}

/** 归一化任意输入为短码；无法识别返回 undefined */
export function parseServer(token: unknown): Server | undefined {
  if (typeof token !== 'string') return undefined
  return SERVER_ALIASES[token.trim().toLowerCase()]
}

/** 宽松版：额外认单字「日」「韩」 */
export function parseServerLoose(token: unknown): Server | undefined {
  return parseServer(token) ?? SERVER_ALIASES_LOOSE[String(token ?? '').trim()]
}

/** 展示名（未知取值原样返回，便于把历史数据或后端新值透出去） */
export function serverDisplay(value: unknown): string {
  const server = parseServer(value)
  return server ? SERVER_DISPLAY[server] : String(value ?? '')
}

/** 用户显式写了就用用户的，否则退回配置的默认列表；都为空时兜底全部四服 */
export function pickDisplayedServers(explicit: unknown, fallback: unknown): Server[] {
  const chosen = normalizeServerList(explicit)
  if (chosen.length) return chosen
  const configured = normalizeServerList(fallback)
  return configured.length ? configured : [...SERVER_LIST]
}

/** 单服指令取哪个服：用户写的第一个，否则配置的默认服，最后兜底港澳台 */
export function pickSingleServer(explicit: unknown, fallback: unknown): Server {
  const chosen = normalizeServerList(explicit)
  if (chosen.length) return chosen[0]
  return parseServer(fallback) ?? 'tw'
}

/** 「港澳台服、日服」这样的并列文案 */
export function serversDisplay(list: readonly Server[]): string {
  return list.map(server => SERVER_DISPLAY[server]).join('、')
}

/** 用法提示里那句服务器写法说明 */
export function serverHint(): string {
  return SERVER_LIST.map(s => `${s}(${SERVER_DISPLAY[s]})`).join(' / ')
}

/**
 * 按玩家 ID 首位推断所在服：`2`→港澳台、`3`→国际、`4`→韩
 * （与后端 `inferServerFromPlayerId` 同一套规则，见 bot/src/features/types/Player.ts）。
 *
 * **日服没有前缀规则**，推断不出时返回 undefined —— 查 jp 必须显式写服务器。
 *
 * 后端里只有 /searchPlayer 收 ID 后自己推断前缀；/playerCard、/b25、/deckBuilder
 * 的解析只认显式服务器（缺省落回缺省服），所以插件替它们补上这同一套推断。
 */
export function inferServerFromPlayerId(playerId: string): Server | undefined {
  switch (playerId[0]) {
    case '2': return 'tw'
    case '3': return 'en'
    case '4': return 'kr'
    default: return undefined
  }
}

/**
 * 归一化一个服务器列表：按 SERVER_LIST 的固定顺序排出、去重、丢掉认不出的值。
 *
 * 入参故意收 `unknown` —— 配置项在某些加载路径下可能缺失（Schema 默认值不一定被应用），
 * 这里统一退化而不是让调用方各自炸掉。
 */
export function normalizeServerList(input: unknown): Server[] {
  const list = Array.isArray(input) ? input : []
  return SERVER_LIST.filter(s => list.some(item => parseServer(item) === s))
}
