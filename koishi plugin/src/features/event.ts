/** 活动：查活动 / 活动歌榜 / 活动榜线 / 活动推荐 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/** 活动选择参数：数字是活动 ID，文本是活动名（只在该服索引里模糊搜索） */
export type EventSelector = string | number | undefined

/**
 * 查活动。
 *
 * 后端按「该服自己有没有这个活动」决定渲染，插件不用管：
 * - 回退链上找到收录该活动的服 → 丰富详情图
 * - 按名字搜到多个 → 活动列表图
 * - 四个服都没有 → 多服组合表（未收录的服显示占位）
 *
 * 上游活动数据由各服独立上传，所以「某服暂时没有」不等于活动不存在。
 */
export async function searchEvent(
  ctx: Context,
  config: Config,
  text: string | undefined,
  servers: Server[],
): Promise<h[]> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return [h.text(MESSAGES.emptyText)]
  return queryEntity(ctx, config, '/searchEvent', servers, trimmed)
}

/**
 * 活动歌榜：该活动每个乐曲榜的名次（玩家名/综合力/出分）。
 *
 * 与查排行一样是**单服**的用户动态数据。活动省略时取该服当前开放的活动。
 * 注意它取的是**活动内的挑战曲榜**，与「查排行」的曲子历史最高分榜不是一回事。
 *
 * @param rank 可选的名次定位：给 `100` 就画**第 91~100 名**那一段（每档 10 行）。
 *             不传表示默认的前十；后端对上游榜长不足的名次会照常出图、在段内注明。
 */
export async function eventSongRanking(
  ctx: Context,
  config: Config,
  server: Server,
  options: { rank?: number, id?: EventSelector } = {},
): Promise<h[]> {
  return queryEntity(ctx, config, '/eventSongRanking', [server], options.id, { rank: options.rank })
}

/**
 * 活动榜线（`ycx` / `ycxall`）：各档分数线随时间的**折线图**。
 *
 * 与活动歌榜是两回事：那边出的是**当前**排行榜，这边出的是**历史**折线。
 * 上游没有历史接口，数据由后端自己按小时采样攒，所以刚接入的活动可能还没有点。
 *
 * @param rank 只画某一档（10/100/1000/5000/10000）；不传表示画全部支持的档位。
 *             档位合不合法由后端按实际数据判定，不适配时它会回一句「当前可用档位: …」，
 *             插件原样透出 —— 插件自己再维护一份档位表只会两边漂移。
 */
export async function eventCutoff(
  ctx: Context,
  config: Config,
  server: Server,
  options: { rank?: number, id?: EventSelector } = {},
): Promise<h[]> {
  return queryEntity(ctx, config, '/cutoffAll', [server], options.id, { rank: options.rank })
}

/**
 * 活动推荐：按目标评级 SS/S/A/B 列出所需综合力最低的谱面。
 *
 * 一张图三截（击奏live / 自由live / 挑战live），算法与站点「歌曲meta」的活动页同源。
 * 活动省略时同样取当前开放的活动。
 */
export async function eventRecommend(
  ctx: Context,
  config: Config,
  server: Server,
  id?: EventSelector,
): Promise<h[]> {
  return queryEntity(ctx, config, '/eventRecommend', [server], id)
}
