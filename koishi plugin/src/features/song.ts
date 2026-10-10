/** 歌曲：查曲 / 随机曲 / 曲效率 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/**
 * 查曲。数字按歌曲 ID 直查，其余文本走模糊搜索 ——
 * 后端 `/searchSong` 内部就做这件事：命中单首出详情图，多首出列表图。
 * 所以这里不需要像参考项目那样先调一次 /fuzzySearch 再回传 fuzzySearchResult。
 */
export async function searchSong(
  ctx: Context,
  config: Config,
  text: string | undefined,
  servers: Server[],
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return [h.text(MESSAGES.emptyText)]
  return queryEntity(ctx, config, '/searchSong', servers, trimmed)
}

/**
 * 随机曲。可选的筛选词（`lv25` 这类后端认的写法）把随机范围限定在匹配的曲目里。
 *
 * 这是**多服**端点：`displayedServerList` 决定信息行里出现哪几个服，
 * 缺省即全部四服。
 */
export async function randomSong(
  ctx: Context,
  config: Config,
  text: string | undefined,
  servers: Server[],
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  return queryEntity(ctx, config, '/songRandom', servers, trimmed || undefined)
}

/**
 * 曲效率（后端叫 songMeta）。
 *
 * 注意这个端点的**语义换过一次**：早期是「全歌曲表」（ID/标题/乐队/等级/时长），
 * 现在是**效率排行** —— 一张图两榜，击奏live 与 自由live 各自效率最高的前 15 张谱面，
 * 四难度混排。所以指令名必须跟着语义改，别再用「分数表」这种叫法去指它。
 *
 * 效率数值与服务器无关（同一份谱面模拟数据），服务器只决定曲名/乐团的显示语言。
 */
export async function songMeta(
  ctx: Context,
  config: Config,
  servers: Server[],
): Promise<h[]> {
  return queryEntity(ctx, config, '/songMeta', servers, undefined)
}
