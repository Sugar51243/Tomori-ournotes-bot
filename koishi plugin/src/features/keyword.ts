/**
 * 用户自定义关键词（Tomori 独有功能，tsugu 没有对应端点）。
 *
 * 给角色 / 角色卡 / 支援卡 / 歌曲挂一个官方名里没有的别名（外号、简称、罗马音），
 * 关键词**参与模糊搜索**，所以挂上之后「查曲 那个外号」就能搜到。
 *
 * 与 `/friend/*` 同一套弱鉴权：`userId`(QQ 号) 只用于留痕与「只能删自己的」，
 * **不是访问鉴权**。依赖后端的 MongoDB；未启用时后端返回域内错误，这里原样透出。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import type { KeywordEntityType } from '../config'
import type { Config } from '../index'
import { query } from '../backend'
import type { SessionInfo } from '../session'

/** 新增关键词（后端会做查重：同实体重复、与现有实体名/别名重合都会被拒） */
export async function keywordUpload(
  ctx: Context,
  config: Config,
  entityType: KeywordEntityType,
  entityId: number,
  keyword: string,
  session: SessionInfo,
): Promise<h[]> {
  return submit(ctx, config, '/keyword/upload', entityType, entityId, keyword, session, '添加')
}

/** 删除关键词：后端按 userId 过滤，只能删自己上传的 */
export async function keywordDelete(
  ctx: Context,
  config: Config,
  entityType: KeywordEntityType,
  entityId: number,
  keyword: string,
  session: SessionInfo,
): Promise<h[]> {
  return submit(ctx, config, '/keyword/delete', entityType, entityId, keyword, session, '删除')
}

async function submit(
  ctx: Context,
  config: Config,
  endpoint: string,
  entityType: KeywordEntityType,
  entityId: number,
  keyword: string,
  session: SessionInfo,
  action: string,
): Promise<h[]> {
  const userId = session.userId
  if (!userId) return [h.text(`拿不到你的用户 ID，无法${action}关键词`)]

  return query(ctx, config, endpoint, {
    userId,
    entityType,
    entityId,
    keyword,
  })
}
