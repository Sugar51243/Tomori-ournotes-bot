/**
 * 公告推流连接管理的单测。
 *
 * 这一层之所以能这样测，是因为 `createStreamManager` 把 open / send / schedule / render
 * 全部做成了依赖 —— 不需要真后端，也不需要 mock 平台适配器
 * （后者尤其重要：`MockBot.sendMessage` 在会话外会直接抛，根本没法用来验后台推送）。
 *
 * 所有用例都显式 `manager.stop()`：这些定时器与流是我们自己造的，
 * 留着会把 vitest 挂住。
 */
import { describe, expect, it } from 'vitest'
import { createStreamManager, type StreamDeps, type StreamManager } from '../../src/stream/manager'
import { channelKeyId, createMemoryStore, type ChannelKey } from '../../src/stream/subscription'
import type { Server } from '../../src/server'
import type { BackendItem } from '../../src/backend'

const TW: ChannelKey = { platform: 'onebot', channelId: '111' }
const JP: ChannelKey = { platform: 'onebot', channelId: '222' }

/** 一个可以手动喂数据的假流 */
function makeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c },
    cancel() { cancelled = true },
  })
  return {
    stream,
    push(text: string) { controller.enqueue(encoder.encode(text)) },
    error(reason = new Error('boom')) { controller.error(reason) },
    close() { controller.close() },
    get cancelled() { return cancelled },
  }
}

/** 手动触发的定时器 */
function makeScheduler() {
  const timers: Array<{ ms: number, fn: () => void, cancelled: boolean }> = []
  return {
    schedule(ms: number, fn: () => void) {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    get pending() { return timers.filter(t => !t.cancelled) },
    /** 触发第一个（或指定毫秒数的）待触发定时器 */
    fire(ms?: number) {
      const timer = ms === undefined ? timers.find(t => !t.cancelled) : timers.find(t => !t.cancelled && t.ms === ms)
      if (!timer) throw new Error(`没有待触发的定时器（${ms ?? '任意'}）`)
      timer.cancelled = true
      timer.fn()
    },
  }
}

/** 让挂在微任务上的 open / 读循环跑起来 */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

interface Harness {
  manager: StreamManager
  streams: Map<Server, ReturnType<typeof makeStream>>
  opened: string[]
  signals: Map<Server, AbortSignal>
  sent: Array<{ target: ChannelKey, elements: unknown[] }>
  scheduler: ReturnType<typeof makeScheduler>
  logs: string[]
}

function makeHarness(
  subscriptions: Array<[ChannelKey, Server[]]>,
  options: { openStatus?: number } = {},
): Harness {
  const store = createMemoryStore()
  for (const [key, servers] of subscriptions) store.subscribe(key, servers)

  const streams = new Map<Server, ReturnType<typeof makeStream>>()
  const signals = new Map<Server, AbortSignal>()
  const opened: string[] = []
  const sent: Array<{ target: ChannelKey, elements: unknown[] }> = []
  const logs: string[] = []
  const scheduler = makeScheduler()

  const deps: StreamDeps = {
    async open(url, signal) {
      opened.push(url)
      const server = url.slice(url.lastIndexOf('/') + 1) as Server
      signals.set(server, signal)
      const stream = makeStream()
      streams.set(server, stream)
      // 记一下 abort，方便断言「连接真的被断开了」
      signal.addEventListener('abort', () => stream.error(new Error('aborted')))
      return { status: options.openStatus ?? 200, data: stream.stream }
    },
    async send(target, elements) {
      sent.push({ target, elements })
    },
    render(items: readonly BackendItem[]) {
      return items.map(item => ({ type: item.type, content: item.string })) as never
    },
    log(level, message) {
      logs.push(`${level}: ${message}`)
    },
    schedule: scheduler.schedule,
  }

  const manager = createStreamManager(store, deps, { baseURL: 'http://backend.test', idleMs: 1000 })

  return { manager, streams, opened, signals, sent, scheduler, logs }
}

const ANNOUNCEMENT = (kind: 'added' | 'updated' = 'added') =>
  `event: announcement\ndata: ${JSON.stringify({
    server: 'tw',
    kind,
    id: '4',
    title: '版本更新公告',
    images: [{ type: 'base64', string: 'QUJD' }],
  })}\n\n`

describe('连接的生命周期', () => {
  it('没有任何订阅时不连接', async () => {
    const h = makeHarness([])
    h.manager.start()
    await flush()

    expect(h.opened).toEqual([])
    expect(h.manager.activeServers()).toEqual([])
    expect(h.scheduler.pending).toEqual([])
    h.manager.stop()
  })

  it('只对「有订阅者的服」建连接', async () => {
    const h = makeHarness([[TW, ['jp']]])
    h.manager.start()
    await flush()

    expect(h.opened).toEqual(['http://backend.test/announcementStream/jp'])
    expect(h.manager.activeServers()).toEqual(['jp'])
    h.manager.stop()
  })

  it('多个服各连一条', async () => {
    const h = makeHarness([[TW, ['tw', 'jp']]])
    h.manager.start()
    await flush()

    expect(h.opened).toEqual([
      'http://backend.test/announcementStream/tw',
      'http://backend.test/announcementStream/jp',
    ])
    h.manager.stop()
  })

  it('start 是幂等的，不会重复连接', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    h.manager.start()
    await flush()

    expect(h.opened).toHaveLength(1)
    h.manager.stop()
  })

  it('新增订阅后 sync() 补上连接，退订后断开且不再重连', async () => {
    const store = createMemoryStore()
    const h = makeHarness([])
    // 用同一套依赖重新造一个 manager，但订阅由外部控制
    const manager = createStreamManager(store, {
      open: async (url, signal) => {
        h.opened.push(url)
        h.signals.set(url.slice(url.lastIndexOf('/') + 1) as Server, signal)
        const stream = makeStream()
        h.streams.set(url.slice(url.lastIndexOf('/') + 1) as Server, stream)
        signal.addEventListener('abort', () => stream.error(new Error('aborted')))
        return { status: 200, data: stream.stream }
      },
      send: async (target, elements) => { h.sent.push({ target, elements }) },
      render: items => items.map(i => ({ type: i.type, content: i.string })) as never,
      log: () => undefined,
      schedule: h.scheduler.schedule,
    }, { baseURL: 'http://backend.test', idleMs: 1000 })

    manager.start()
    await flush()
    expect(manager.activeServers()).toEqual([])

    await store.subscribe(TW, ['tw'])
    manager.sync()
    await flush()
    expect(manager.activeServers()).toEqual(['tw'])

    await store.unsubscribe(TW)
    manager.sync()
    await flush()
    expect(manager.activeServers()).toEqual([])
    expect(h.signals.get('tw')?.aborted).toBe(true)
    // 主动断开不是「掉线」，不该安排重连
    expect(h.scheduler.pending).toEqual([])

    manager.stop()
  })
})

describe('事件派发', () => {
  it('收到公告后向该服的每个订阅频道各推一条，内容含抬头与图片', async () => {
    const h = makeHarness([[TW, ['tw']], [JP, ['tw']]])
    h.manager.start()
    await flush()

    h.streams.get('tw')!.push(ANNOUNCEMENT('added'))
    await flush()

    expect(h.sent).toHaveLength(2)
    expect(h.sent.map(s => s.target)).toEqual([TW, JP])
    const elements = h.sent[0].elements as Array<{ content?: string }>
    expect(elements[0]).toEqual({ type: 'string', content: '【港澳台服】公告新增：版本更新公告' })
    expect(elements[1]).toEqual({ type: 'base64', content: 'QUJD' })

    h.manager.stop()
  })

  it('只推给订阅了该服的频道', async () => {
    const h = makeHarness([[TW, ['jp']]])
    h.manager.start()
    await flush()

    h.streams.get('jp')!.push(ANNOUNCEMENT().replace('"server":"tw"', '"server":"jp"'))
    await flush()

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].target).toEqual(TW)
    h.manager.stop()
  })

  it('一条流里连着来多个事件都能推', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    h.streams.get('tw')!.push(ANNOUNCEMENT('added') + ANNOUNCEMENT('updated'))
    await flush()

    expect(h.sent).toHaveLength(2)
    h.manager.stop()
  })

  it('ready 握手与心跳不当成公告推', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    h.streams.get('tw')!.push('event: ready\ndata: {"server":"tw","pollSeconds":300}\n\n: ping\n\n')
    await flush()

    expect(h.sent).toEqual([])
    h.manager.stop()
  })

  it('载荷坏了只记日志，不掐断整条流（后续事件照推）', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    h.streams.get('tw')!.push('event: announcement\ndata: {坏的\n\n' + ANNOUNCEMENT())
    await flush()

    expect(h.sent).toHaveLength(1)
    expect(h.logs.some(l => l.includes('无法解析'))).toBe(true)
    h.manager.stop()
  })

  it('某个频道发送失败不影响其它频道', async () => {
    const store = createMemoryStore()
    await store.subscribe(TW, ['tw'])
    await store.subscribe(JP, ['tw'])
    const sent: ChannelKey[] = []
    const logs: string[] = []
    const scheduler = makeScheduler()
    const stream = makeStream()

    const manager = createStreamManager(store, {
      open: async () => ({ status: 200, data: stream.stream }),
      send: async (target) => {
        // 按值比较：store.channelsFor 每次返回的是新对象
        if (channelKeyId(target) === channelKeyId(TW)) throw new Error('这个频道挂了')
        sent.push(target)
      },
      render: items => items.map(i => ({ type: i.type, content: i.string })) as never,
      log: (level, message) => { logs.push(`${level}: ${message}`) },
      schedule: scheduler.schedule,
    }, { baseURL: 'http://backend.test' })

    manager.start()
    await flush()
    stream.push(ANNOUNCEMENT())
    await flush()

    expect(sent).toEqual([JP])
    expect(logs.some(l => l.includes('推送公告失败'))).toBe(true)
    manager.stop()
  })
})

describe('空闲看门狗与重连', () => {
  it('连接建立后启动空闲看门狗；收到数据会重置它', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    // 建链后应该有一个 1000ms 的看门狗
    expect(h.scheduler.pending.map(t => t.ms)).toEqual([1000])

    h.streams.get('tw')!.push(': ping\n\n')
    await flush()

    // 重置 = 旧的取消、新的排上，仍然只有一个待触发
    expect(h.scheduler.pending.map(t => t.ms)).toEqual([1000])
    h.manager.stop()
  })

  it('空闲超时主动断开并重连 —— 不这样半开连接会永远挂着', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    h.scheduler.fire(1000)
    await flush()

    expect(h.signals.get('tw')?.aborted).toBe(true)
    expect(h.logs.some(l => l.includes('判定连接已死'))).toBe(true)
    // 掉线后按退避安排重连（第一档 15s）
    expect(h.scheduler.pending.map(t => t.ms)).toEqual([15_000])

    h.scheduler.fire(15_000)
    await flush()
    expect(h.opened).toHaveLength(2)
    h.manager.stop()
  })

  it('流正常结束也安排重连', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()

    h.streams.get('tw')!.close()
    await flush()

    expect(h.scheduler.pending.map(t => t.ms)).toEqual([15_000])
    h.manager.stop()
  })

  it('连不上时按退避重试，档位逐步拉长', async () => {
    const store = createMemoryStore()
    await store.subscribe(TW, ['tw'])
    const scheduler = makeScheduler()
    let attempts = 0

    const manager = createStreamManager(store, {
      open: async () => {
        attempts++
        throw new Error('connect ECONNREFUSED')
      },
      send: async () => undefined,
      render: () => [],
      log: () => undefined,
      schedule: scheduler.schedule,
    }, { baseURL: 'http://backend.test' })

    manager.start()
    await flush()
    expect(attempts).toBe(1)
    expect(scheduler.pending.map(t => t.ms)).toEqual([15_000])

    scheduler.fire(15_000)
    await flush()
    expect(attempts).toBe(2)
    expect(scheduler.pending.map(t => t.ms)).toEqual([30_000])

    scheduler.fire(30_000)
    await flush()
    expect(attempts).toBe(3)
    expect(scheduler.pending.map(t => t.ms)).toEqual([60_000])

    manager.stop()
  })

  it('后端回非 200 时也按掉线处理', async () => {
    const h = makeHarness([[TW, ['tw']]], { openStatus: 502 })
    h.manager.start()
    await flush()

    expect(h.logs.some(l => l.includes('HTTP 502'))).toBe(true)
    expect(h.scheduler.pending.map(t => t.ms)).toEqual([15_000])
    h.manager.stop()
  })

  it('退订后即便有在途的退避定时器也不会再连', async () => {
    const store = createMemoryStore()
    await store.subscribe(TW, ['tw'])
    const h = makeHarness([])
    let opens = 0

    const manager = createStreamManager(store, {
      open: async () => {
        opens++
        throw new Error('ECONNREFUSED')
      },
      send: async () => undefined,
      render: () => [],
      log: () => undefined,
      schedule: h.scheduler.schedule,
    }, { baseURL: 'http://backend.test' })

    manager.start()
    await flush()
    expect(opens).toBe(1)

    await store.unsubscribe(TW)
    manager.sync()
    // 退订把待触发的重连也取消了
    expect(h.scheduler.pending).toEqual([])

    manager.stop()
  })
})

describe('stop', () => {
  it('停掉全部连接与定时器，且可重复调用', async () => {
    const h = makeHarness([[TW, ['tw', 'jp']]])
    h.manager.start()
    await flush()
    expect(h.scheduler.pending).toHaveLength(2)

    h.manager.stop()
    expect(h.manager.activeServers()).toEqual([])
    expect(h.signals.get('tw')?.aborted).toBe(true)
    expect(h.signals.get('jp')?.aborted).toBe(true)
    // 没有挂起的定时器 —— 否则 vitest 会被开着的手柄拖住
    expect(h.scheduler.pending).toEqual([])

    h.manager.stop()
    await flush()
    expect(h.opened).toHaveLength(2)
  })

  it('停掉之后再 sync() 不会重新连上', async () => {
    const h = makeHarness([[TW, ['tw']]])
    h.manager.start()
    await flush()
    h.manager.stop()

    h.manager.sync()
    await flush()
    expect(h.opened).toHaveLength(1)
  })
})
