/** 卡片：查卡 / 查角色卡 / 查支援卡 / 查卡面 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { CardKind } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/**
 * 三个查卡入口的端点映射。
 * 角色卡与支援卡的 ID 空间重叠，所以「按 ID 查」必须靠入口区分种类。
 */
const CARD_ENDPOINTS: Record<CardKind, string> = {
  auto: '/searchCard',
  member: '/searchMemberCard',
  support: '/searchSupportCard',
}

/**
 * 查卡。
 *
 * @param entry    入口决定的种类（固定入口查哪一类）
 * @param explicit 用户在参数里额外写的种类 —— **只有整合入口 `/searchCard` 认这个字段**，
 *                 固定入口（member/support）传了后端也会忽略，所以干脆不发。
 */
export async function searchCard(
  ctx: Context,
  config: Config,
  text: string | undefined,
  entry: CardKind,
  servers: Server[],
  explicit?: CardKind,
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return [h.text(MESSAGES.emptyText)]

  const extra: Record<string, unknown> = {}
  if (entry === 'auto' && explicit) extra.cardType = explicit

  return queryEntity(ctx, config, CARD_ENDPOINTS[entry] || CARD_ENDPOINTS.auto, servers, trimmed, extra)
}

/**
 * 查卡面：直出原图（角色卡竖版 / 支援卡横版）。
 *
 * 后端只收整数 ID（不做文本搜索，所以这里必须是数字），
 * 服务器取回退链上第一个收录该卡的服。
 */
export async function cardIllustration(
  ctx: Context,
  config: Config,
  cardId: number,
  servers: Server[],
  cardType?: CardKind,
): Promise<h[]> {
  return queryEntity(ctx, config, '/getCardIllustration', servers, cardId, { cardType })
}
