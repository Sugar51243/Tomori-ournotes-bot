/**
 * 公告推流的订阅表。
 *
 * Koishi 的 `ctx.database` 需要额外装数据库驱动，本项目不引入依赖，
 * 所以订阅直接存成一个 JSON 文件（`<ctx.baseDir>/data/tomori-ournotes/subscriptions.json`）。
 *
 * 结构：
 * ```json
 * { "version": 1, "channels": { "onebot:123456": { "platform": "onebot", "channelId": "123456", "servers": ["tw"] } } }
 * ```
 * 键用 `platform:channelId` —— channelId 在不同平台上可能撞车。
 *
 * 所有读写都不抛错：文件坏了/不存在一律当空表，插件不能因为一个订阅文件起不来。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SERVER_LIST, normalizeServerList, parseServer } from '../server'
import type { Server } from '../server'

export interface ChannelKey {
  platform: string
  channelId: string
}

export interface SubscriptionStore {
  /** 把订阅文件读进内存。幂等；读失败/文件不存在都当成空表，不抛错 */
  load(): Promise<void>
  /** 订阅了该服的全部频道（按 SERVER_LIST 顺序去重后返回） */
  channelsFor(server: Server): ChannelKey[]
  /** 该频道订阅的全部服务器 */
  serversFor(key: ChannelKey): Server[]
  /** 追加订阅，返回该频道当前的全部订阅 */
  subscribe(key: ChannelKey, servers: readonly Server[]): Promise<Server[]>
  /** 退订（不传 servers 表示退订全部），返回剩余订阅 */
  unsubscribe(key: ChannelKey, servers?: readonly Server[]): Promise<Server[]>
  /** 全部频道 */
  all(): ChannelKey[]
  /** 是否有任何订阅（没有就不必连流） */
  isEmpty(): boolean
}

export interface SubscriptionData {
  version: number
  channels: Record<string, { platform: string; channelId: string; servers: Server[] }>
}

export function channelKeyId(key: ChannelKey): string {
  return `${key.platform}:${key.channelId}`
}

/**
 * 容错解析：任何形状不对的输入都退化成空表。
 * 单独导出是为了让单测能直接喂字符串，不必碰文件系统。
 */
export function parseSubscriptions(raw: string): SubscriptionData {
  const empty: SubscriptionData = { version: 1, channels: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const channels = (parsed as Record<string, unknown>).channels
  if (typeof channels !== 'object' || channels === null) return empty

  const out: SubscriptionData = { version: 1, channels: {} }
  for (const [key, value] of Object.entries(channels as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (typeof record.platform !== 'string' || typeof record.channelId !== 'string') continue
    if (!Array.isArray(record.servers)) continue
    const servers: Server[] = []
    for (const item of record.servers) {
      const server = parseServer(item)
      if (server && !servers.includes(server)) servers.push(server)
    }
    // 一条订阅都没有的频道不必留着
    if (!servers.length) continue
    out.channels[key] = { platform: record.platform, channelId: record.channelId, servers: normalizeServerList(servers) }
  }
  return out
}

export function serializeSubscriptions(data: SubscriptionData): string {
  return JSON.stringify(data, null, 2) + '\n'
}

/**
 * 文件实现。
 *
 * - 写入走「临时文件 + rename」：rename 在同一分区上是原子的，读者永远不会看到半个文件
 * - 写入串行化：并发 `subscribe` 不会互相覆盖（都在同一条 promise 链上）
 */
export function createFileStore(path: string): SubscriptionStore {
  let data: SubscriptionData = { version: 1, channels: {} }
  /**
   * 读盘只做一次，且**必须让后来者等同一个 promise**。
   * 早先的写法是「进函数就把标志位置 true 再去 await」，那样启动时的
   * `load()` 还没读完，紧跟着的 `subscribe()` 就以为已经加载完了，
   * 直接改内存数据，随后又被迟到的读盘结果整个覆盖 —— 订阅凭空消失。
   */
  let loading: Promise<void> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const load = (): Promise<void> => {
    if (!loading) {
      loading = (async () => {
        try {
          data = parseSubscriptions(await readFile(path, 'utf-8'))
        } catch {
          data = { version: 1, channels: {} }
        }
      })()
    }
    return loading
  }

  // 所有写操作排在同一条链上，避免「读-改-写」交叉导致丢条目
  const mutate = <T>(fn: () => T): Promise<T> => {
    const next = queue.then(async () => {
      await load()
      const result = fn()
      await persist()
      return result
    })
    // 失败不能卡住后面的操作
    queue = next.catch(() => undefined)
    return next
  }

  const persist = async (): Promise<void> => {
    try {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, serializeSubscriptions(data), 'utf-8')
      await rename(tmp, path)
    } catch {
      // 落盘失败不该让指令报错，内存里的订阅本次运行仍然有效
    }
  }

  const setServers = (key: ChannelKey, servers: Server[]): Server[] => {
    const id = channelKeyId(key)
    const normalized = normalizeServerList(servers)
    if (normalized.length) {
      data.channels[id] = { platform: key.platform, channelId: key.channelId, servers: normalized }
    } else {
      delete data.channels[id]
    }
    return normalized
  }

  return {
    load,
    channelsFor(server: Server): ChannelKey[] {
      const out: ChannelKey[] = []
      for (const entry of Object.values(data.channels)) {
        if (entry.servers.includes(server)) out.push({ platform: entry.platform, channelId: entry.channelId })
      }
      return out
    },
    serversFor(key: ChannelKey): Server[] {
      const entry = data.channels[channelKeyId(key)]
      return normalizeServerList(entry ? entry.servers : [])
    },
    all(): ChannelKey[] {
      return Object.values(data.channels).map(e => ({ platform: e.platform, channelId: e.channelId }))
    },
    isEmpty(): boolean {
      return Object.keys(data.channels).length === 0
    },
    subscribe(key: ChannelKey, servers: readonly Server[]): Promise<Server[]> {
      return mutate(() => {
        const current = data.channels[channelKeyId(key)]?.servers ?? []
        return setServers(key, [...current, ...servers])
      })
    },
    unsubscribe(key: ChannelKey, servers?: readonly Server[]): Promise<Server[]> {
      return mutate(() => {
        const current = data.channels[channelKeyId(key)]?.servers ?? []
        const next = servers?.length ? current.filter(s => !servers.includes(s)) : []
        return setServers(key, next)
      })
    },
  }
}

/** 内存实现（单测用；也是 runner 里「不落盘」的兜底） */
export function createMemoryStore(initial?: Partial<Record<string, Server[]>>): SubscriptionStore {
  let data: SubscriptionData = { version: 1, channels: {} }
  if (initial) {
    for (const [id, servers] of Object.entries(initial)) {
      if (!servers?.length) continue
      const index = id.indexOf(':')
      const platform = index < 0 ? 'mock' : id.slice(0, index)
      const channelId = index < 0 ? id : id.slice(index + 1)
      data.channels[id] = { platform, channelId, servers: normalizeServerList(servers) }
    }
  }

  const setServers = (key: ChannelKey, servers: Server[]): Server[] => {
    const id = channelKeyId(key)
    const normalized = normalizeServerList(servers)
    if (normalized.length) {
      data.channels[id] = { platform: key.platform, channelId: key.channelId, servers: normalized }
    } else {
      delete data.channels[id]
    }
    return normalized
  }

  return {
    async load(): Promise<void> {
      // 内存实现没有外部状态要读
    },
    channelsFor(server: Server): ChannelKey[] {
      const out: ChannelKey[] = []
      for (const entry of Object.values(data.channels)) {
        if (entry.servers.includes(server)) out.push({ platform: entry.platform, channelId: entry.channelId })
      }
      return out
    },
    serversFor(key: ChannelKey): Server[] {
      return normalizeServerList(data.channels[channelKeyId(key)]?.servers ?? [])
    },
    all(): ChannelKey[] {
      return Object.values(data.channels).map(e => ({ platform: e.platform, channelId: e.channelId }))
    },
    isEmpty(): boolean {
      return Object.keys(data.channels).length === 0
    },
    async subscribe(key: ChannelKey, servers: readonly Server[]): Promise<Server[]> {
      const current = data.channels[channelKeyId(key)]?.servers ?? []
      return setServers(key, [...current, ...servers])
    },
    async unsubscribe(key: ChannelKey, servers?: readonly Server[]): Promise<Server[]> {
      const current = data.channels[channelKeyId(key)]?.servers ?? []
      const next = servers?.length ? current.filter(s => !servers.includes(s)) : []
      return setServers(key, next)
    },
  }
}

/** 各服各有多少订阅者（用于日志与「要不要连」的判断） */
export function countByServer(store: SubscriptionStore): Record<Server, number> {
  const out = {} as Record<Server, number>
  for (const server of SERVER_LIST) out[server] = store.channelsFor(server).length
  return out
}

/** 订阅文件的默认路径 */
export function defaultSubscriptionPath(baseDir: string): string {
  return join(baseDir, 'data', 'tomori-ournotes', 'subscriptions.json')
}
