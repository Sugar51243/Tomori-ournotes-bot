/** 角色查询 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/**
 * 查角色：整数走 ID，其余走模糊搜索（也可按乐团名/活动名搜到角色）；
 * 命中单个直接出详情图，多个出列表图。
 */
export async function searchCharacter(
  ctx: Context,
  config: Config,
  text: string | undefined,
  servers: Server[],
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return [h.text(MESSAGES.emptyText)]
  return queryEntity(ctx, config, '/searchCharacter', servers, trimmed)
}
