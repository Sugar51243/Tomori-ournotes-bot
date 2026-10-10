/**
 * 集成测试：**打真实的 Tomori 后端**（不注入假 http，走 Koishi 官方的 http 服务）。
 *
 * 这里验证的是单测覆盖不到的那一层：请求体字段名/类型是否真的被后端接受、
 * 大图 base64 是否能原样变成可发送的图片元素、真实错误响应长什么样。
 *
 * 默认打 http://127.0.0.1:3002（后端 .env 里的 PORT），可用环境变量覆盖：
 *
 *   TOMORI_TEST_BACKEND=http://127.0.0.1:3102 npm test
 *
 * 后端没起时整组跳过，不会让 npm test 失败。
 *
 * 断言刻意保持宽松（只验「有图」或「文案里出现了关键词」）——
 * 出图内容由后端决定，后端改版式不该让插件测试红。
 * 对「后端有没有启用数据库」也保持宽容：交友/车站那几条只要求插件把后端的
 * 答复清楚地转达给用户，所以 MongoDB 起没起都能跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
// 命名导出：@koishijs/plugin-http 的 ESM 产物用 `export *`，不转发 default
import { HTTP } from '@koishijs/plugin-http'
import { createLiveApp, isBackendCompatible, isBackendUp, type TestApp } from '../helpers'

const BACKEND = process.env.TOMORI_TEST_BACKEND ?? 'http://127.0.0.1:3002'

/** 实测可用的真实数据：「诗超绊」在后端能唯一解析到 100008 */
const SONG_ID = 100008
const SONG_NAME = '诗超绊'

const backendUp = await isBackendUp(BACKEND)
const backendCompatible = backendUp && await isBackendCompatible(BACKEND)

if (!backendUp) {
  console.warn(`[integration] ${BACKEND} 不可达，跳过集成测试。设 TOMORI_TEST_BACKEND 可指向别处。`)
} else if (!backendCompatible) {
  console.warn(
    `[integration] ${BACKEND} 上的服务不是这一版契约的后端（/health 没有返回四区域列表），跳过集成测试。\n` +
    '            这一版插件对应 Tomori-ournotes-bot 的多服版本；请改指正确的实例：\n' +
    '            TOMORI_TEST_BACKEND=http://127.0.0.1:3102 npm test',
  )
}

/** 后端出图的统一判据：一段够长的 data:image base64 */
const IMAGE = /<img src="data:image\//

describe.skipIf(!backendCompatible)('集成：真实 Tomori 后端', () => {
  let live: TestApp

  beforeAll(async () => {
    live = await createLiveApp(BACKEND)
  })
  afterAll(async () => {
    await live?.dispose()
  })

  it('后端状态能读到四服的版本信息', async () => {
    const text = (await live.app.mock.client('10000').receive('后端状态')).join('')
    expect(text).toContain('Tomori 后端正常')
    expect(text).toContain('缺省区域: tw')
    expect(text).toMatch(/港澳台服: .+/)
    expect(text).toMatch(/已运行: /)
  })

  it('查曲：默认四服，真实出图（是后端给的图，不是我们编的）', async () => {
    const replies = await live.app.mock.client('10000').receive(`查曲 ${SONG_NAME}`)
    expect(replies.join('')).toMatch(IMAGE)
  })

  it('查曲：限定单服也能出图', async () => {
    // 这里按 ID 查而不是按曲名：各服的模糊索引是**独立分片**的，
    // 日服索引里只有日文曲名，拿中文名去搜 jp 本来就不该有结果
    const replies = await live.app.mock.client('10000').receive(`查曲 ${SONG_ID} jp`)
    expect(replies.join('')).toMatch(IMAGE)
  })

  it('查谱面：歌名一步交给后端，出 24 轨谱面图（不再经过客户端 /fuzzySearch）', async () => {
    const replies = await live.app.mock.client('10000').receive(`查谱面 ${SONG_NAME} ex`)
    const text = replies.join('')
    // 谱面图是后端画的大图，base64 一定很长
    expect(text).toMatch(IMAGE)
    expect(text.length).toBeGreaterThan(10_000)
  })

  it('查谱面：速度参数被后端接受', async () => {
    const replies = await live.app.mock.client('10000').receive(`查谱面 ${SONG_ID} ex 速度7.5`)
    expect(replies.join('')).toMatch(IMAGE)
  })

  it('谱面数据：真实 meta 被摘要成文字', async () => {
    const text = (await live.app.mock.client('10000').receive(`谱面数据 ${SONG_ID} ex`)).join('')
    expect(text).toContain(SONG_NAME)
    expect(text).toContain('expert')
    expect(text).toMatch(/BPM: \d/)
    expect(text).toMatch(/轨道: 24/)
  })

  it('曲效率能出图（旧名 曲表 也还能用）', async () => {
    const client = live.app.mock.client('10000')
    expect((await client.receive('曲效率')).join('')).toMatch(IMAGE)
    expect((await client.receive('曲表')).join('')).toMatch(IMAGE)
  })

  it('查角色能出图', async () => {
    const replies = await live.app.mock.client('10000').receive('查角色 千早爱音')
    expect(replies.join('')).toMatch(IMAGE)
  })

  it('查乐团能出图', async () => {
    const client = live.app.mock.client('10000')
    // 名字与 ID 两条路都验一下（ID 走的是另一条分支）
    expect((await client.receive('查乐团 MyGO')).join('')).toMatch(new RegExp(`${IMAGE.source}|没有搜索到`))
    expect((await client.receive('查乐团 1')).join('')).toMatch(new RegExp(`${IMAGE.source}|错误`))
  })

  it('活动歌榜：不传活动 ID 时取当前活动', async () => {
    const text = (await live.app.mock.client('10000').receive('活动歌榜 tw')).join('')
    // 没有开放活动/上游取不到时后端有自己的域内文案，两种都算通过
    expect(text).toMatch(new RegExp(`${IMAGE.source}|错误`))
    expect(text).not.toContain('undefined')
  })

  it('活动歌榜：名次参数被后端接受（不是 400）', async () => {
    // 这里验的是「rank 字段真被后端认」，具体画第几名由后端决定、不归插件断言
    const text = (await live.app.mock.client('10000').receive('活动歌榜 100 tw')).join('')
    expect(text).toMatch(new RegExp(`${IMAGE.source}|错误`))
    expect(text).not.toContain('参数错误')
    expect(text).not.toContain('undefined')
  })

  it('活动榜线 ycx / ycxall 能出图或给出可读文案', async () => {
    const client = live.app.mock.client('10000')
    // 榜线数据由后端按小时采样攒，刚起的实例可能还没有点 —— 后端会出图并附说明
    const ycx = (await client.receive('ycx 100 tw')).join('')
    expect(ycx).toMatch(new RegExp(`${IMAGE.source}|错误`))
    expect(ycx).not.toContain('undefined')

    const all = (await client.receive('ycxall tw')).join('')
    expect(all).toMatch(new RegExp(`${IMAGE.source}|错误`))
  })

  it('活动推荐能出图或给出可读文案', async () => {
    const text = (await live.app.mock.client('10000').receive('活动推荐 tw')).join('')
    expect(text).toMatch(new RegExp(`${IMAGE.source}|错误`))
    expect(text).not.toContain('undefined')
  })

  it('查排行：真实的动态数据接口', async () => {
    const text = (await live.app.mock.client('10000').receive(`查排行 ${SONG_ID} tw`)).join('')
    // 该曲可能还没有人打过，两种结果都算通过 —— 关键是插件把后端的答复转达清楚了
    expect(text).toMatch(new RegExp(`${IMAGE.source}|排行|暂无|错误`))
  })

  it('查排行：歌名也能查（文本只在该服索引里搜，新契约才支持）', async () => {
    const text = (await live.app.mock.client('10000').receive(`查排行 ${SONG_NAME} tw`)).join('')
    expect(text).toMatch(new RegExp(`${IMAGE.source}|排行|暂无|没有搜索到|错误`))
    expect(text).not.toContain('参数错误')
  })

  it('活动三件套：活动名也能写（活动歌榜 / 活动推荐）', async () => {
    const client = live.app.mock.client('10000')

    const ranking = (await client.receive('活动歌榜 夏日祭 tw')).join('')
    expect(ranking).toMatch(new RegExp(`${IMAGE.source}|错误|没有搜索到`))
    expect(ranking).not.toContain('参数错误')

    const recommend = (await client.receive('活动推荐 夏日祭 tw')).join('')
    expect(recommend).toMatch(new RegExp(`${IMAGE.source}|错误|没有搜索到`))
    expect(recommend).not.toContain('参数错误')
  })

  it('抽卡模拟：默认 10 连出图，卡池也能写名字', async () => {
    const client = live.app.mock.client('10000')

    const byDefault = (await client.receive('抽卡模拟 10 tw')).join('')
    expect(byDefault).toMatch(new RegExp(`${IMAGE.source}|错误`))
    expect(byDefault).not.toContain('参数错误')

    const byName = (await client.receive('抽卡模拟 10 夏日祭 tw')).join('')
    expect(byName).toMatch(new RegExp(`${IMAGE.source}|错误|匹配到多个卡池|没有搜索到`))
    expect(byName).not.toContain('参数错误')
  })

  it('查玩家：不传服务器时由后端按 ID 首位推断', async () => {
    // 默认数据源只能查到 StarMoe 已验证公开的账号，查不到是正常的域内文案
    const text = (await live.app.mock.client('10000').receive('查玩家 2000000000')).join('')
    expect(text).toMatch(new RegExp(`${IMAGE.source}|未公开|不存在|错误`))
  })

  /**
   * 账号包四件套（发名片 / b25 / 组卡 / 绑定管理）依赖网页平台与数据库，
   * 与交友/车站同一套宽容断言：只要求插件把后端的答复清楚地转达出来。
   * 插件的职责是「请求体被接受」——所以还要盯着不能出现 400 参数错误。
   */
  it('发名片 / b25 / 组卡：请求体被接受，答复可读', async () => {
    const client = live.app.mock.client('10000')

    // 名片是原图直出；账号不存在/未公开时是域内文案
    const card = (await client.receive('发名片 2000000000')).join('')
    expect(card).toMatch(new RegExp(`${IMAGE.source}|未公开|不存在|错误`))
    expect(card).not.toContain('参数错误')

    const b25 = (await client.receive('b25 2000000000')).join('')
    expect(b25).toMatch(new RegExp(`${IMAGE.source}|账号包|未公开|错误|绑定`))
    expect(b25).not.toContain('参数错误')

    const deck = (await client.receive('组卡 2000000000')).join('')
    expect(deck).toMatch(new RegExp(`${IMAGE.source}|账号包|未公开|错误|绑定|活动`))
    expect(deck).not.toContain('参数错误')
  })

  it('绑定管理：把后端的答复转达清楚（启用数据库则给出绑定列表/引导）', async () => {
    const client = live.app.mock.client('10000')

    const list = (await client.receive('玩家绑定')).join('')
    expect(list).toMatch(/已绑定的游戏账号|还没有绑定|错误/)

    // 绑定码格式合法但不存在 —— 后端（或网页平台）会回一句可读的失败文案
    const bind = (await client.receive('绑定玩家 ABC12345')).join('')
    expect(bind).toMatch(/绑定|错误|失败/)
  })

  it('公告列表能出图，公告详情查不存在的 ID 会把域内文案透出来', async () => {
    const client = live.app.mock.client('10000')

    const list = (await client.receive('公告列表 tw')).join('')
    expect(list).toMatch(new RegExp(`${IMAGE.source}|暂无公告`))

    const missing = (await client.receive('公告 999999')).join('')
    expect(missing).toMatch(/该公告不存在|错误/)
  })

  it('查贴纸：不存在的 ID 会把后端的域内文案原样透出', async () => {
    const text = (await live.app.mock.client('10000').receive('查贴纸 999999')).join('')
    expect(text).toContain('该贴纸不存在')
  })

  it('查贴纸：存在的 ID 出图', async () => {
    const replies = await live.app.mock.client('10000').receive('查贴纸 1')
    expect(replies.join('')).toMatch(IMAGE)
  })

  it('查贴纸：关键词搜索与列出全部都出列表图', async () => {
    const client = live.app.mock.client('10000')

    const searched = (await client.receive('查贴纸 高松灯')).join('')
    expect(searched).toMatch(new RegExp(`${IMAGE.source}|没有搜索到符合条件的贴纸`))

    // 全部贴纸可能分页成多张图，这里只看有没有图
    const all = (await client.receive('查贴纸 全部')).join('')
    expect(all).toMatch(IMAGE)
  })

  /**
   * 交友与车站依赖后端的 MongoDB。本机 27017 没起时会返回
   * 「错误: 服务器未启用数据库」，这是**正常的域内错误**。
   *
   * 所以这里断言的是「插件把后端的答复清楚地转达给了用户」，
   * 而不是某一种具体结果 —— 这样 MongoDB 起没起都能跑。
   */
  it('交友/车站：把后端的答复转达给用户（启用数据库则出图/成功）', async () => {
    const client = live.app.mock.client('10000', '20000')

    const friendList = (await client.receive('交友列表')).join('')
    expect(friendList).toMatch(/<img src="data:image\/|错误|交友列表为空/)

    const roomList = (await client.receive('车来')).join('')
    expect(roomList).toMatch(/<img src="data:image\/|错误|车站列表为空/)

    const upload = (await client.receive('上传车牌 123456 集成测试')).join('')
    expect(upload).toMatch(/<img src="data:image\/|已|错误/)

    const friendUpload = (await client.receive('交友登记 1234567890 jp')).join('')
    expect(friendUpload).toMatch(/<img src="data:image\/|已|错误/)
  })

  it('查活动：给出可读结果而不是崩', async () => {
    const text = (await live.app.mock.client('10000').receive('查活动 测试')).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(new RegExp(`${IMAGE.source}|没有搜索到|错误`))
    expect(text).not.toContain('undefined')
  })

  it('关键词：依赖数据库，把后端的答复转达清楚', async () => {
    // 与交友/车站同一套宽容断言：MongoDB 起没起都能跑
    const text = (await live.app.mock.client('10000').receive('新增关键词 歌曲 100001 集成测试别名')).join('')
    expect(text).toMatch(/已添加关键词|错误|失败/)

    const removed = (await live.app.mock.client('10000').receive('删除关键词 歌曲 100001 集成测试别名')).join('')
    expect(removed).toMatch(/已删除|没有找到|错误|失败/)
  })
})

/**
 * 公告推流的**传输层机制**单独验一次。
 *
 * 单测里 `open` 是注入的假实现，所以「`ctx.http` 配 `responseType: 'stream'` + `timeout: 0`
 * 到底能不能拿到一条可读的 SSE 流」是唯一没被覆盖的一环 —— 而它恰好是整条推流的地基。
 * 这里用真的 Koishi http 服务打后端的真 SSE 端点，只读到 `ready` 握手就收手。
 *
 * 这是一条永不主动结束的长连接，所以：整段用 AbortController 兜住（读到就 abort），
 * `finally` 里一定断开，免得把测试进程拖住。
 */
describe.skipIf(!backendCompatible)('集成：SSE 传输（推流依赖的机制）', () => {
  it('ctx.http 的流式响应能读到 ready 握手', async () => {
    const app = new Context()
    app.plugin(HTTP)
    await app.start()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    let text = ''
    try {
      const response = await (app.http as unknown as (
        url: string,
        options: Record<string, unknown>,
      ) => Promise<{ status: number, headers: Headers, data: ReadableStream<Uint8Array> }>)(
        `${BACKEND.replace(/\/+$/, '')}/announcementStream/tw`,
        {
          method: 'GET',
          responseType: 'stream',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
          // 长连接不能不设 —— 传 0 才是「没有超时」
          timeout: 0,
          validateStatus: () => true,
        },
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.data).toBeInstanceOf(ReadableStream)

      const reader = response.data.getReader()
      const decoder = new TextDecoder()
      while (!text.includes('\n\n')) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
      await reader.cancel()
    } catch (error) {
      // abort 是收尾手段，不算失败；其它错误照抛
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }

    expect(text).toContain('event: ready')
    expect(text).toContain('"server":"tw"')
    expect(text).toMatch(/"pollSeconds":\d+/)
  })
})
