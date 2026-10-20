/**
 * 订阅表的单测。
 *
 * 大部分用例跑内存实现（快、无副作用）；文件实现只在一组用例里真落盘，
 * 验的是「原子写不写坏文件」「坏文件降级为空表」「并发写不丢条目」这三件容易出错的事。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  channelKeyId,
  countByServer,
  createFileStore,
  createMemoryStore,
  parseSubscriptions,
  serializeSubscriptions,
} from '../../src/stream/subscription'

const GROUP: Parameters<ReturnType<typeof createMemoryStore>['subscribe']>[0] = { platform: 'onebot', channelId: '123' }
const OTHER: Parameters<ReturnType<typeof createMemoryStore>['subscribe']>[0] = { platform: 'onebot', channelId: '456' }

describe('parseSubscriptions', () => {
  it('解析正常结构', () => {
    const data = parseSubscriptions(JSON.stringify({
      version: 1,
      channels: { 'onebot:123': { platform: 'onebot', channelId: '123', servers: ['jp', 'tw'] } },
    }))
    // 服务器按固定顺序归一
    expect(data.channels['onebot:123'].servers).toEqual(['tw', 'jp'])
  })

  it('坏 JSON / 形状不对都降级为空表，而不是抛错', () => {
    expect(parseSubscriptions('{坏了')).toEqual({ version: 1, channels: {} })
    expect(parseSubscriptions('null')).toEqual({ version: 1, channels: {} })
    expect(parseSubscriptions('[]')).toEqual({ version: 1, channels: {} })
    expect(parseSubscriptions('{"channels": 5}')).toEqual({ version: 1, channels: {} })
  })

  it('丢掉认不出的服务器；一条都不剩的频道直接删掉', () => {
    const data = parseSubscriptions(JSON.stringify({
      version: 1,
      channels: {
        'onebot:1': { platform: 'onebot', channelId: '1', servers: ['jp', '火星服'] },
        'onebot:2': { platform: 'onebot', channelId: '2', servers: ['火星服'] },
        'onebot:3': { platform: 'onebot', channelId: '3', servers: 'jp' },
        'onebot:4': { platform: 'onebot', servers: ['jp'] },
      },
    }))
    expect(Object.keys(data.channels)).toEqual(['onebot:1'])
    expect(data.channels['onebot:1'].servers).toEqual(['jp'])
  })

  it('序列化回去能被重新解析（往返一致）', () => {
    const raw = serializeSubscriptions({
      version: 1,
      channels: { 'onebot:1': { platform: 'onebot', channelId: '1', servers: ['tw'] } },
    })
    expect(parseSubscriptions(raw).channels['onebot:1'].servers).toEqual(['tw'])
  })
})

describe('订阅表（内存实现）', () => {
  it('订阅是累积的、幂等的', async () => {
    const store = createMemoryStore()
    expect(await store.subscribe(GROUP, ['tw'])).toEqual(['tw'])
    expect(await store.subscribe(GROUP, ['jp', 'tw'])).toEqual(['tw', 'jp'])
    expect(store.serversFor(GROUP)).toEqual(['tw', 'jp'])
  })

  it('按服查频道', async () => {
    const store = createMemoryStore()
    await store.subscribe(GROUP, ['tw', 'jp'])
    await store.subscribe(OTHER, ['tw'])
    expect(store.channelsFor('tw').map(channelKeyId)).toEqual(['onebot:123', 'onebot:456'])
    expect(store.channelsFor('jp').map(channelKeyId)).toEqual(['onebot:123'])
    expect(store.channelsFor('kr')).toEqual([])
    expect(countByServer(store)).toEqual({ tw: 2, jp: 1, kr: 0, en: 0 })
  })

  it('退订指定的服，退订全部则传空', async () => {
    const store = createMemoryStore()
    await store.subscribe(GROUP, ['tw', 'jp'])
    expect(await store.unsubscribe(GROUP, ['jp'])).toEqual(['tw'])
    expect(await store.unsubscribe(GROUP)).toEqual([])
    expect(store.serversFor(GROUP)).toEqual([])
    expect(store.isEmpty()).toBe(true)
  })

  it('退订一个没订过的服不会凭空造出条目', async () => {
    const store = createMemoryStore()
    expect(await store.unsubscribe(GROUP, ['kr'])).toEqual([])
    expect(store.all()).toEqual([])
  })

  it('频道键带上 platform，避免不同平台撞车', async () => {
    const store = createMemoryStore()
    await store.subscribe({ platform: 'discord', channelId: '123' }, ['tw'])
    await store.subscribe({ platform: 'onebot', channelId: '123' }, ['jp'])
    expect(store.channelsFor('tw')).toEqual([{ platform: 'discord', channelId: '123' }])
    expect(store.channelsFor('jp')).toEqual([{ platform: 'onebot', channelId: '123' }])
  })
})

describe('订阅表（文件实现）', () => {
  const dirs: string[] = []

  async function tempFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tomori-sub-'))
    dirs.push(dir)
    return join(dir, 'nested', 'subscriptions.json')
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('写进去再读出来还是那些订阅（目录不存在会自动建）', async () => {
    const path = await tempFile()
    const store = createFileStore(path)
    await store.subscribe(GROUP, ['tw', 'jp'])

    // tmp 文件不该留下
    await expect(readFile(`${path}.tmp`)).rejects.toThrow()

    const reloaded = createFileStore(path)
    await reloaded.load()
    expect(reloaded.serversFor(GROUP)).toEqual(['tw', 'jp'])
  })

  it('文件不存在时按空表处理', async () => {
    const store = createFileStore(await tempFile())
    await store.load()
    expect(store.isEmpty()).toBe(true)
  })

  it('文件坏了也不让插件起不来', async () => {
    const path = await tempFile()
    const store = createFileStore(path)
    await store.subscribe(GROUP, ['tw'])   // 先把目录建出来
    await writeFile(path, '{这不是 JSON', 'utf-8')

    const reloaded = createFileStore(path)
    await reloaded.load()
    expect(reloaded.isEmpty()).toBe(true)
    // 坏文件之后仍然能正常写入
    await reloaded.subscribe(OTHER, ['jp'])
    expect(reloaded.serversFor(OTHER)).toEqual(['jp'])
  })

  it('load() 还在读盘时就 subscribe，订阅不会被迟到的读盘结果覆盖', async () => {
    // 回归用例：早期实现进 load() 就把「已加载」标志置 true 再去 await，
    // 于是启动瞬间的订阅会被随后返回的读盘结果整个盖掉
    const path = await tempFile()
    const seed = createFileStore(path)
    await seed.subscribe(OTHER, ['kr'])

    const store = createFileStore(path)
    const loading = store.load()          // 故意不 await
    await store.subscribe(GROUP, ['tw'])  // 抢在读完之前写
    await loading

    expect(store.serversFor(GROUP)).toEqual(['tw'])
    expect(store.serversFor(OTHER)).toEqual(['kr'])
  })

  it('并发订阅不会互相覆盖（写操作串行化）', async () => {
    const path = await tempFile()
    const store = createFileStore(path)
    await store.load()
    await Promise.all([
      store.subscribe(GROUP, ['tw']),
      store.subscribe(OTHER, ['jp']),
      store.subscribe({ platform: 'discord', channelId: '789' }, ['kr']),
    ])

    const reloaded = createFileStore(path)
    await reloaded.load()
    expect(reloaded.all()).toHaveLength(3)
    expect(countByServer(reloaded)).toEqual({ tw: 1, jp: 1, kr: 1, en: 0 })
  })

  it('落盘失败（路径不可写）不抛错，内存里的订阅本次运行仍然有效', async () => {
    // 用一个不可能建成的路径：把文件路径指向已存在文件的子路径
    const path = await tempFile()
    await writeFile(path.replace('/nested/', '/'), 'x', 'utf-8').catch(() => undefined)
    const store = createFileStore(join(path, 'x', 'y.json'))
    await expect(store.subscribe(GROUP, ['tw'])).resolves.toEqual(['tw'])
    expect(store.serversFor(GROUP)).toEqual(['tw'])
  })
})
