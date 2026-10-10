/** 车站（房间号共享）：车来 / 上传车牌 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Config } from '../index'
import { query } from '../backend'
import { parseRoomInput } from '../parse'
import type { SessionInfo } from '../session'

/**
 * 车来：车站列表图。
 *
 * 不传 roomList，让后端直接查它自己的库 —— 后端 /roomList 已经处理了
 * 「车站列表为空」和「未启用数据库」两种情况，所以**不需要**像参考项目那样
 * 先 GET /station/queryAllRoom 拿 JSON 再 POST 回来渲染。省一次往返。
 */
export async function roomList(ctx: Context, config: Config): Promise<h[]> {
  return query(ctx, config, '/roomList', { compress: config.compress })
}

/**
 * 上传车牌。
 *
 * raw 是用户输入的整行（例如 `123456 上车`），房号与备注在这里拆开：
 * 这样能保留前导 0（后端 number 字段是 isInt，只能送数字，
 * 但 rawMessage 里保留用户原文，展示时不会丢）。
 */
export async function submitRoom(
  ctx: Context,
  config: Config,
  raw: string | undefined,
  session: SessionInfo,
): Promise<h[]> {
  const parsed = parseRoomInput(raw ?? '')
  if (!parsed) {
    return [h.text(MESSAGES.invalidRoomNumber)]
  }

  const userId = session.userId
  if (!userId) return [h.text(`${MESSAGES.missingUserId}，无法上传车牌`)]

  const body: Record<string, unknown> = {
    number: parsed.number,
    rawMessage: parsed.raw,
    // 后端会把 onebot/red/chronocat/llonebot/napcat 归一成 qq
    platform: session.platform ?? 'unknown',
    userId,
    userName: session.username || userId,
    time: Date.now(),
  }
  const avatar = session.avatar
  if (avatar) body.avatarUrl = avatar

  return query(ctx, config, '/station/submitRoomNumber', body)
}
