/**
 * 玩家相关：查排行 / 查玩家（含网页账号包）/ 发名片 / b25 / 组卡 / 绑定管理。
 *
 * 这些都是**动态用户数据**，一次只查一个服 —— 服务器用单值列表
 * `displayedServerList: [server]` 指定（后端单服端点取首个、不回退）。
 *
 * 四个「查玩家类」端点（/searchPlayer、/playerCard、/b25、/deckBuilder）共用
 * 一套目标解析（见后端 features/player/playerBind.ts 的 resolvePlayerTarget）：
 * 给 playerId 就用它，不给就带 userId 让后端取**默认绑定**。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { DeckMode } from '../config'
import { inferServerFromPlayerId } from '../server'
import type { Server } from '../server'
import type { Config } from '../index'
import { query, queryEntity } from '../backend'

/**
 * 查排行：该曲前十用户的排行与出分（单服一图）。
 *
 * 歌名与数字 ID 都收：文本只在**这一个服**的索引里搜索，
 * 唯一命中出排行图，多命中出歌曲列表图。
 */
export async function songRanking(
  ctx: Context,
  config: Config,
  query_: string,
  server: Server,
): Promise<h[]> {
  return queryEntity(ctx, config, '/songRanking', [server], query_)
}

/** 玩家类端点共用的目标：显式 ID（可带服务器）或「绑定的默认账号」（userId） */
export interface PlayerTarget {
  /** 玩家 ID；省略 = 用绑定里的默认账号 */
  playerId?: string
  /** 用户显式写的服务器 */
  server?: Server
  /** QQ 号；playerId 省略时后端用它取默认绑定 */
  userId?: string
}

/**
 * 组装玩家类端点的请求体。
 *
 * `inferServer` 只有 /searchPlayer 用不到：**那个端点由后端按 ID 首位推断服务器**
 * （2→tw / 3→en / 4→kr，日服没有前缀规则），插件如果擅自填个默认服，
 * 等于把后端的推断机制废掉。其余三条端点后端只认显式服务器，
 * 所以由插件补上同一套推断（见 inferServerFromPlayerId 的说明）。
 *
 * playerId 省略时**只发 userId**：服务器由后端从绑定记录里取（绑定里记着服）。
 */
function playerTargetBody(config: Config, target: PlayerTarget, inferServer: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { compress: config.compress }
  const id = (target.playerId ?? '').trim()

  if (id) {
    body.playerId = id
    const server = target.server ?? (inferServer ? inferServerFromPlayerId(id) : undefined)
    if (server) body.displayedServerList = [server]
  } else if (target.userId) {
    body.userId = target.userId
  }

  return body
}

/**
 * 查玩家：玩家档案图（最爱卡面大图 + 国旗服名 + 名称/等级/应援数/经验），
 * 有网页账号包时**再附一张账号包图**（完成状态 / 乐队道具 / 各乐队理论最高综合力队伍）。
 */
export async function searchPlayer(
  ctx: Context,
  config: Config,
  target: PlayerTarget,
): Promise<h[]> {
  const id = (target.playerId ?? '').trim()
  if (target.playerId !== undefined && !id) return [h.text(MESSAGES.invalidPlayerId)]
  return query(ctx, config, '/searchPlayer', playerTargetBody(config, target, false))
}

/**
 * 发名片：玩家在游戏里自己设计的那套名片（当前使用的，1~3 页）的**原图**。
 *
 * 不给页码时后端按页依次发全部原图；给了 page 就只发那一页。
 */
export async function playerCard(
  ctx: Context,
  config: Config,
  target: PlayerTarget,
  page?: number,
): Promise<h[]> {
  const body = playerTargetBody(config, target, true)
  if (page !== undefined) body.page = page
  return query(ctx, config, '/playerCard', body)
}

/**
 * B25 计分榜：账号最强 25 张谱面（封面/曲名/难度/等级/计入值/分数/总计值）。
 * 数据来自**网页账号包**，需要该账号包的歌曲公开。
 */
export async function b25(
  ctx: Context,
  config: Config,
  target: PlayerTarget,
): Promise<h[]> {
  return query(ctx, config, '/b25', playerTargetBody(config, target, true))
}

/**
 * 组卡工具：推荐队伍与收益/效率曲（与网页组卡器同一套算法）。
 *
 * 不写 mode 时后端按 auto 处理（有进行中的活动就用活动模式）；
 * 给了 eventId 就是活动模式（后端强制，往期/未开始的活动也能用报酬表）。
 * 需要该账号包的卡片与道具公开。
 */
export async function deckBuilder(
  ctx: Context,
  config: Config,
  target: PlayerTarget,
  options: { mode?: DeckMode, eventId?: number } = {},
): Promise<h[]> {
  const body = playerTargetBody(config, target, true)
  if (options.mode) body.mode = options.mode
  if (options.eventId !== undefined) body.eventId = options.eventId
  return query(ctx, config, '/deckBuilder', body)
}

//=====绑定管理=====//
// 一个 QQ 可绑多个游戏账号；绑定码在网页「我的账号」里按账号包生成（一次性、15 分钟）。
// 绑定只做两件事：免输玩家 ID + 证明账号归属，**不解锁任何隐藏数据**
//（群里的展示一律按网页的公开开关，绑定本人也一样）。

/** 兑换绑定码（新增/更新一条绑定，首个自动设为默认） */
export async function playerBind(
  ctx: Context,
  config: Config,
  userId: string,
  code: string,
): Promise<h[]> {
  return query(ctx, config, '/playerBind/bind', { userId, code })
}

/** 列出该 QQ 的全部绑定（★ = 默认账号） */
export async function playerBindList(
  ctx: Context,
  config: Config,
  userId: string,
): Promise<h[]> {
  return query(ctx, config, '/playerBind/list', { userId })
}

/** 解绑一个账号（playerId 或列表序号二选一） */
export async function playerUnbind(
  ctx: Context,
  config: Config,
  userId: string,
  selector: { playerId?: string, index?: number },
): Promise<h[]> {
  return query(ctx, config, '/playerBind/unbind', { userId, ...selector })
}

/** 切换默认账号（不传 ID 的查玩家 / 发名片 / b25 / 组卡 用它） */
export async function playerUse(
  ctx: Context,
  config: Config,
  userId: string,
  selector: { playerId?: string, index?: number },
): Promise<h[]> {
  return query(ctx, config, '/playerBind/use', { userId, ...selector })
}
