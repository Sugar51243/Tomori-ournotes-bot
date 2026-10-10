/**
 * 公告推流的连接管理。
 *
 * 后端 `/announcementStream/{tw|jp|kr|en}` 是四条**独立**的 SSE 长连接，
 * 只在公告新增/修改时推该条公告的详情图（连接时不发快照、下架不推）。
 *
 * 这里的三条设计约束：
 *
 * 1. **按需连接**。只对「有订阅者的服」建连接，最后一个订阅者退订就断开 ——
 *    后端只在有订阅者时才轮询上游，闲着不连是对上游最基本的礼貌。
 * 2. **必须有自己的空闲看门狗**。SSE 请求用 `timeout: 0`（不这样会被 Koishi 的
 *    http 超时掐断），代价是**半开连接会永远挂着、连 error 事件都没有**。
 *    后端心跳 25s，所以只要 90s 收不到任何字节就判定连接已死、主动 abort 重连。
 * 3. **IO 全部可注入**。`open` / `send` / `schedule` / `render` 都是依赖，
 *    单测里换成假的就能把「连接 → 收事件 → 派发 → 重连」整条链路跑一遍，
 *    不需要真后端，也不需要 mock 平台适配器。
 */
import type { h } from 'koishi'
import type { BackendItem } from '../backend'
import { SERVER_LIST } from '../server'
import type { Server } from '../server'
import { announcementHeader, createSseParser, decodeAnnouncementEvent } from './sse'
import type { SseEvent } from './sse'
import type { ChannelKey, SubscriptionStore } from './subscription'

export interface StreamDeps {
  /** 建立 SSE 连接。resolve 出响应；传输层失败请直接 throw */
  open(url: string, signal: AbortSignal): Promise<{ status: number, data: ReadableStream<Uint8Array> | null }>
  /** 往一个频道推消息。抛错由 manager 兜住并记日志，不影响其它频道 */
  send(target: ChannelKey, elements: h[]): Promise<void>
  /** 把后端的图/文案元素渲染成 Koishi 元素 */
  render(items: readonly BackendItem[]): h[]
  log(level: 'info' | 'warn', message: string): void
  /** 定时器，返回取消函数 */
  schedule(ms: number, fn: () => void): () => void
}

export interface StreamConfig {
  /** 后端地址（不带末尾斜杠） */
  baseURL: string
  /** 多久没收到任何字节就判定连接已死。后端心跳 25s，取它的数倍 */
  idleMs?: number
  /** 重连退避（毫秒），依次取用，最后一档封顶 */
  backoffMs?: number[]
}

export interface StreamManager {
  /** 启动（幂等）。之后每次订阅变化都要调 sync() */
  start(): void
  /** 停掉全部连接与定时器（幂等） */
  stop(): void
  /** 按当前订阅对齐连接：该连的连上、没人订的断开 */
  sync(): void
  /** 当前正在连的服（测试与日志用） */
  activeServers(): Server[]
}

/** 没收到任何字节就认为连接已死的阈值 */
const DEFAULT_IDLE_MS = 90_000
/** 退避：连不上时别把后端打爆 */
const DEFAULT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000]

interface Worker {
  server: Server
  controller: AbortController
  /** 用户主动断开（退订/停用）：这不叫掉线，不该重连 */
  stopped: boolean
  /** 退避档位 */
  attempt: number
  /** 重置空闲看门狗 */
  bump: () => void
  /** 取消当前的空闲看门狗 */
  cancelIdle?: () => void
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

export function createStreamManager(
  store: SubscriptionStore,
  deps: StreamDeps,
  config: StreamConfig,
): StreamManager {
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS
  const backoff = config.backoffMs?.length ? config.backoffMs : DEFAULT_BACKOFF_MS
  const baseURL = config.baseURL.replace(/\/+$/, '')

  const workers = new Map<Server, Worker>()
  /** 全部待触发的定时器（空闲看门狗 + 重连），stop() 时要一并取消 */
  const timers = new Set<() => void>()
  /** 每个服待触发的重连定时器，退订时要单独取消 */
  const retries = new Map<Server, () => void>()
  let running = false

  const wanted = (): Server[] => SERVER_LIST.filter(server => store.channelsFor(server).length > 0)

  /** 登记一个定时器，返回的取消函数会同时把它从登记表里摘掉 */
  const schedule = (ms: number, fn: () => void): (() => void) => {
    let cancel: () => void = () => undefined
    cancel = deps.schedule(ms, () => {
      timers.delete(cancel)
      fn()
    })
    timers.add(cancel)
    return () => {
      timers.delete(cancel)
      cancel()
    }
  }

  const clearTimers = (): void => {
    for (const cancel of timers) cancel()
    timers.clear()
    retries.clear()
  }

  /** 收事件 → 派发。这里绝不能抛，否则会掐断整条流的读取循环 */
  const handleEvent = (server: Server, event: SseEvent): void => {
    if (event.event === 'ready') {
      deps.log('info', `[${server}] 公告推流已就绪`)
      return
    }
    if (event.event !== 'announcement') return

    const payload = decodeAnnouncementEvent(event.data)
    if (!payload) {
      deps.log('warn', `[${server}] 公告推流载荷无法解析，已忽略`)
      return
    }

    const targets = store.channelsFor(server)
    deps.log('info', `[${server}] 公告${payload.kind === 'updated' ? '更新' : '新增'}: ${payload.title}（订阅频道 ${targets.length}）`)
    if (!targets.length) return

    const elements = [...deps.render([{ type: 'string', string: announcementHeader(payload) }]), ...deps.render(payload.images)]
    for (const target of targets) {
      // 即发即忘：一个慢/挂掉的频道不能拖住整条流的读取
      void deps.send(target, elements).catch((error) => {
        deps.log('warn', `向 ${target.platform}:${target.channelId} 推送公告失败: ${describeError(error)}`)
      })
    }
  }

  /** 读一条流直到结束或出错 */
  const consume = async (worker: Worker, stream: ReadableStream<Uint8Array>): Promise<void> => {
    const parser = createSseParser()
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          worker.bump()
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            handleEvent(worker.server, event)
          }
        }
      }
      for (const event of parser.flush()) handleEvent(worker.server, event)
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 已经被 abort 时 cancel 会抛，忽略
      }
    }
  }

  const connect = (server: Server, attempt: number): void => {
    if (!running) return
    deps.log('info', `[${server}] 正在连接公告推流${attempt > 0 ? `（第 ${attempt + 1} 次尝试）` : ''}`)
    const controller = new AbortController()
    const worker: Worker = {
      server,
      controller,
      stopped: false,
      attempt,
      bump: () => undefined,
    }
    worker.bump = () => {
      worker.cancelIdle?.()
      worker.cancelIdle = schedule(idleMs, () => {
        deps.log('warn', `[${server}] 公告推流 ${idleMs / 1000}s 没收到数据，判定连接已死，重连`)
        controller.abort(new Error('idle timeout'))
      })
    }
    workers.set(server, worker)

    void (async () => {
      try {
        const response = await deps.open(`${baseURL}/announcementStream/${server}`, controller.signal)
        if (worker.stopped || !running) {
          // 连接期间被退订/停用：把已经建立的流关掉，不要再读
          await response.data?.cancel().catch(() => undefined)
          return
        }
        if (response.status !== 200 || !response.data) {
          throw new Error(`后端返回 HTTP ${response.status}`)
        }
        worker.bump()
        await consume(worker, response.data)
      } catch (error) {
        // 主动断开（退订/停用）不是错误，不刷日志
        if (!worker.stopped) {
          deps.log('warn', `[${server}] 公告推流断开: ${describeError(error)}`)
        }
      } finally {
        worker.cancelIdle?.()
        if (workers.get(server) === worker) workers.delete(server)
        // 空闲看门狗超时也会 abort，所以判据是「用户主动断开」而不是「signal.aborted」
        if (running && !worker.stopped && wanted().includes(server)) {
          const delay = backoff[Math.min(worker.attempt, backoff.length - 1)]
          retries.set(server, schedule(delay, () => {
            retries.delete(server)
            connect(server, worker.attempt + 1)
          }))
        }
      }
    })()
  }

  const disconnect = (server: Server): void => {
    // 掉线中的服没有 worker，但可能挂着待触发的重连定时器
    retries.get(server)?.()
    retries.delete(server)

    const worker = workers.get(server)
    if (!worker) return
    worker.stopped = true
    workers.delete(server)
    worker.cancelIdle?.()
    worker.controller.abort(new Error('unsubscribed'))
  }

  const sync = (): void => {
    if (!running) return
    const want = wanted()
    for (const server of want) {
      if (!workers.has(server) && !retries.has(server)) connect(server, 0)
    }
    for (const server of new Set([...workers.keys(), ...retries.keys()])) {
      if (!want.includes(server)) disconnect(server)
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      sync()
    },
    stop(): void {
      running = false
      for (const server of new Set([...workers.keys(), ...retries.keys()])) disconnect(server)
      clearTimers()
    },
    sync,
    activeServers(): Server[] {
      return SERVER_LIST.filter(server => workers.has(server))
    },
  }
}
