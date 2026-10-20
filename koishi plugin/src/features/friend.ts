/**
 * 交友（Tomori 独有功能，tsugu 没有对应端点）。
 *
 * 写操作没有鉴权，以自报的 QQ 号为准 —— 这也意味着「解除交友」只能删自己的。
 * 依赖后端的 MongoDB；未启用时后端会返回「错误: 服务器未启用数据库」，
 * 这里原样透出给用户，不额外包装。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { query } from '../backend'
import { toInteger } from '../parse'
import type { SessionInfo } from '../session'

/** 交友登记 / 更新：同一 QQ 号覆盖，一人一条 */
export async function friendUpload(
  ctx: Context,
  config: Config,
  playerIdRaw: string | undefined,
  server: Server,
  session: SessionInfo,
): Promise<h[]> {
  const playerId = toInteger(playerIdRaw)
  if (playerId === undefined) {
    // 区分「没写」和「写了但不是数字」，报错更有指向性
    return [h.text((playerIdRaw ?? '').trim() ? MESSAGES.invalidPlayerId : MESSAGES.missingPlayerId)]
  }

  const userId = session.userId
  if (!userId) return [h.text(`${MESSAGES.missingUserId}，无法登记交友信息`)]

  const body: Record<string, unknown> = {
    userId,
    userName: session.username || userId,
    // 后端校验 playerId 为纯数字字符串
    playerId: String(playerId),
    server,
  }
  if (session.avatar) body.avatarUrl = session.avatar

  return query(ctx, config, '/friend/upload', body)
}

/** 解除交友：自报 QQ 号即删 */
export async function friendDelete(
  ctx: Context,
  config: Config,
  session: SessionInfo,
): Promise<h[]> {
  const userId = session.userId
  if (!userId) return [h.text(`${MESSAGES.missingUserId}，无法解除交友信息`)]
  return query(ctx, config, '/friend/delete', { userId })
}

/** 交友列表图（每 30 人分页） */
export async function friendList(ctx: Context, config: Config): Promise<h[]> {
  return query(ctx, config, '/friend/list', { compress: config.compress })
}
