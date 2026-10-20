/** 卡池：查卡池 / 抽卡模拟 */
import type { h } from 'koishi'
import type { Context } from 'koishi'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'

/**
 * 查卡池详情。数字按卡池 ID 直查，其余文本走模糊搜索
 * （唯一命中出详情图，多命中出卡池列表图）。
 */
export async function searchGacha(
  ctx: Context,
  config: Config,
  gachaId: string | number,
  servers: Server[],
): Promise<h[]> {
  return queryEntity(ctx, config, '/searchGacha', servers, gachaId)
}

/**
 * 抽卡模拟。**单服**端点，服务器取列表第一个。
 *
 * - 不传卡池时后端取该服当前开放的卡池
 * - 卡池可以写 ID 或名字（文本只在该服索引里搜索，多命中后端回一句
 *   「匹配到多个卡池，请用 gachaId 精确指定」，原样透出）
 * - 后端的 10 连保底是按游戏规则的近似；times > 10000 会被后端拒绝并回一句文案
 */
export async function gachaSimulate(
  ctx: Context,
  config: Config,
  times: number,
  server: Server,
  gacha?: string | number,
): Promise<h[]> {
  return queryEntity(ctx, config, '/gachaSimulate', [server], gacha, { times })
}
