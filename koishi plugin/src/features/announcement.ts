/**
 * 公告。
 *
 * 后端把公告拆成两个职责不重叠的接口：
 * - `POST /announcements` —— 一次性查询：不传 id 出列表图，传 id 出该条详情图
 * - `GET /announcementStream/{server}` —— 推流：只在新增/修改时推该条详情图（见 stream/）
 *
 * 这里是前者，外加订阅/退订的命令实现（后者由 stream/manager 负责真正连接）。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from '../config'
import { SERVER_LIST, serversDisplay, normalizeServerList } from '../server'
import type { Server } from '../server'
import type { Config } from '../index'
import { queryEntity } from '../backend'
import type { ChannelKey, SubscriptionStore } from '../stream/subscription'

/** 公告列表图（单服一图） */
export async function announcementList(
  ctx: Context,
  config: Config,
  server: Server,
): Promise<h[]> {
  return queryEntity(ctx, config, '/announcements', [server], undefined)
}

/** 该条公告的详情图（正文过长时分页，会返回多张图） */
export async function announcementDetail(
  ctx: Context,
  config: Config,
  id: string,
  server: Server,
): Promise<h[]> {
  return queryEntity(ctx, config, '/announcements', [server], id)
}

/** 订阅命令需要的上下文（由 index.ts 组装） */
export interface SubscriptionContext {
  store: SubscriptionStore
  /** 订阅变化后让 manager 重新对齐连接 */
  sync(): void
  /** 机器人侧推流总开关；关闭时仍可登记，但要提示收不到 */
  enabled: boolean
}

/** 本会话当前订阅的服（按固定顺序）。读之前先确保订阅文件已经加载 */
async function currentSubscriptions(sub: SubscriptionContext, key: ChannelKey): Promise<Server[]> {
  await sub.store.load()
  return sub.store.serversFor(key)
}

function subscriptionSummary(servers: Server[]): string {
  return servers.length ? serversDisplay(servers) : '无'
}

/** 订阅本会话的公告推流（幂等，可累积多个服） */
export async function subscribeAnnouncements(
  sub: SubscriptionContext,
  key: ChannelKey,
  servers: Server[],
): Promise<h[]> {
  if (!servers.length) return [h.text(MESSAGES.missingSubscribeServer)]

  await sub.store.subscribe(key, servers)
  sub.sync()

  const current = await currentSubscriptions(sub, key)
  const lines = [`已在本会话订阅公告推流：${serversDisplay(normalizeServerList(servers))}`]
  lines.push(`当前订阅：${subscriptionSummary(current)}`)
  lines.push('（连接时不发快照，只有新发布或修改的公告会推过来）')
  if (!sub.enabled) lines.push(MESSAGES.subscriptionDisabled)
  return [h.text(lines.join('\n'))]
}

/**
 * 退订。不传 servers 表示退订全部。
 * 指定了服务器但本会话没订过时明确说出来，而不是假装成功。
 */
export async function unsubscribeAnnouncements(
  sub: SubscriptionContext,
  key: ChannelKey,
  servers?: Server[],
): Promise<h[]> {
  const current = await currentSubscriptions(sub, key)

  if (!servers?.length) {
    if (!current.length) return [h.text(MESSAGES.noSubscription)]
    await sub.store.unsubscribe(key)
    sub.sync()
    return [h.text('已关闭本会话全部公告推流')]
  }

  const wanted = normalizeServerList(servers)
  const missing = wanted.filter(server => !current.includes(server))
  if (missing.length === wanted.length) {
    return [h.text(`本会话没有订阅${serversDisplay(wanted)}的公告推流`)]
  }

  await sub.store.unsubscribe(key, servers)
  sub.sync()
  const remaining = await currentSubscriptions(sub, key)
  return [h.text(`已关闭本会话 [${serversDisplay(wanted)}] 的公告推流\n当前订阅：${subscriptionSummary(remaining)}`)]
}

/** 用法提示（`公告` 不带参数时用） */
export function announcementUsage(): h[] {
  return [h.text([
    '查询 Our Notes 游戏公告（四服务器相互独立）',
    `服务器：${SERVER_LIST.join(' / ')}`,
    '公告列表 [服务器] —— 出该服公告列表图',
    '公告 <公告ID> [服务器] —— 出该条公告详情图',
    '公告 最新 [服务器] —— 出该服最新一条公告的详情图',
    '公告订阅 <服务器…> —— 订阅本会话的公告推流',
    '公告退订 [服务器…] —— 退订（不带服务器则退订全部）',
  ].join('\n'))]
}
