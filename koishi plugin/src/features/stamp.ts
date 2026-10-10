/**
 * 贴纸：查贴纸。
 *
 * 后端 `/getStampImage` 有三种互斥用法，插件这三种都要能表达：
 * ① `id` 传数字 → 直出官方贴纸**原图**（不加工）
 * ② `id` 传文本 → 模糊搜索，出**列表图**（每格标出 ID 与名称，结果多时按 30/页分页）
 * ③ 都不传    → 列出该服全部贴纸（同样是列表图）
 *
 * `stampType` 只在 ② 有意义（决定关键词只认哪一类名称），
 * 带数字 ID 或列全部时后端不认这个字段，所以那时不发。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { StampScope } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

export interface StampQuery {
  /** 按 ID 直出原图 */
  stampId?: number
  /** 模糊搜索的关键词；与 stampId 互斥 */
  text?: string
  /** 关键词只认哪一类名称 */
  scope?: StampScope
}

export async function stampImage(
  ctx: Context,
  config: Config,
  query: StampQuery,
  servers: Server[],
): Promise<h[]> {
  const text = (query.text ?? '').trim()
  const extra: Record<string, unknown> = {}
  let id: string | number | undefined

  if (query.stampId !== undefined) {
    id = query.stampId
  } else if (text) {
    id = text
    if (query.scope) extra.stampType = query.scope
  } else if (!servers.length) {
    // 不传 id 与关键词 = 列出该服全部贴纸，没有服务器就无从列起
    return [h.text(MESSAGES.emptyText)]
  }

  return queryEntity(ctx, config, '/getStampImage', servers, id, extra)
}
