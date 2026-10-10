/** 乐团查询 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/**
 * 查乐团。
 *
 * 与其它静态实体一样是**多服一图**：主体用「自己有该乐团」的服渲染，下方附各服信息。
 * 数字 ID 走 ID，其余走模糊搜索 —— 也能按角色名搜到其所属乐团，
 * 乐团还可以挂自定义关键词（见 features/keyword.ts）。
 */
export async function searchBand(
  ctx: Context,
  config: Config,
  text: string | undefined,
  servers: Server[],
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return [h.text(MESSAGES.emptyText)]
  return queryEntity(ctx, config, '/searchBand', servers, trimmed)
}
