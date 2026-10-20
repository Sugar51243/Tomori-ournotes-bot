/**
 * 指令层测试：**模拟输入 → 真实 Koishi → 模拟输出**。
 *
 * 用真实的 Koishi 运行时（指令注册、参数解析、before-send 钩子都是它自己的实现），
 * 只把 `ctx.http` 换成记录型假实现：
 * - 断言插件到底向后端发了什么请求体（这是最容易出错、也最值得锁住的部分）
 * - 完全控制后端回什么，覆盖各种成功/失败/畸形响应
 *
 * 输入用 `app.mock.client(...)` 发消息，输出用返回的序列化回复断言。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import {
  createTestApp,
  httpError,
  imageReply,
  jsonFailed,
  jsonSuccess,
  ok,
  textReply,
  type Responder,
  type TestApp,
} from '../helpers'
import { MESSAGES } from '../../src/config'
import { SERVER_LIST } from '../../src/server'

/** 静态实体查询的默认服务器（配置默认值） */
const ALL_SERVERS = [...SERVER_LIST]

/** 后端返回图片 */
const IMAGE = imageReply()
/** 后端返回域内错误文案 */
const NO_RESULT = textReply('没有搜索到符合条件的歌曲')

/** 按 endpoint 后缀路由的假后端；未命中的请求会返回一句可定位问题的文案 */
function router(routes: Record<string, unknown>): Responder {
  return (request) => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (request.url.endsWith(suffix)) return ok(body)
    }
    return ok(textReply(`未预期的请求: ${request.url}`))
  }
}

describe('查曲 / 随机曲 / 曲效率', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp(router({
      '/searchSong': IMAGE,
      '/songRandom': IMAGE,
      '/songMeta': IMAGE,
    }))
  })
  afterAll(() => app.dispose())

  it('查曲默认查全部四服，查询词放进统一的 id 字段', async () => {
    const replies = await app.app.mock.client('10000').receive('查曲 诗超绊')

    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('<img')
    expect(app.bodyFor('/searchSong')).toEqual({
      displayedServerList: ALL_SERVERS,
      id: '诗超绊',
      compress: true,
    })
  })

  it('查曲只发一次请求（不做客户端模糊搜索）', async () => {
    const before = app.requests.length
    await app.app.mock.client('10000').receive('查曲 100008')
    // 参考项目会先 /fuzzySearch 再 /searchSong；Tomori 的 /searchSong 内部已做模糊搜索
    expect(app.requests.length - before).toBe(1)
    expect(app.requests[app.requests.length - 1].url).toContain('/searchSong')
  })

  it('写上服务器就只查那些服，与位置无关', async () => {
    const client = app.app.mock.client('10000')
    await client.receive('查曲 迷星叫 jp')
    expect(app.bodyFor('/searchSong')).toMatchObject({ displayedServerList: ['jp'], id: '迷星叫' })

    await client.receive('查曲 jp tw 迷星叫')
    expect(app.bodyFor('/searchSong')).toMatchObject({ displayedServerList: ['tw', 'jp'], id: '迷星叫' })
  })

  it('只写服务器而没写曲名时不发请求，直接提示缺查询词', async () => {
    const before = app.requests.length
    const replies = await app.app.mock.client('10000').receive('查曲 tw jp')
    expect(app.requests.length - before).toBe(0)
    expect(replies.join('')).toContain(MESSAGES.emptyText)
  })

  it('随机曲不带筛选词时不发 id 字段', async () => {
    await app.app.mock.client('10000').receive('随机曲')
    const body = app.bodyFor('/songRandom') as Record<string, unknown>
    expect(body).toEqual({ displayedServerList: ALL_SERVERS, compress: true })
    expect('id' in body).toBe(false)
  })

  it('随机曲带筛选词与服务器时两者都发', async () => {
    // lv25 是后端认的筛选词（写在 id 里，数字以外的文本由后端当搜索词）
    await app.app.mock.client('10000').receive('随机曲 lv25 jp')
    expect(app.bodyFor('/songRandom')).toMatchObject({ id: 'lv25', displayedServerList: ['jp'] })
  })

  it('曲效率只发 displayedServerList（服务器只决定显示语言）', async () => {
    await app.app.mock.client('10000').receive('曲效率')
    expect(app.bodyFor('/songMeta')).toEqual({
      displayedServerList: ALL_SERVERS,
      compress: true,
    })
  })

  it('旧名 曲表 / 分数表 / 查询分数表 仍然指向曲效率，并能限定服务器', async () => {
    // 这个端点的语义从「全歌曲表」换成了「效率排行」，旧名保留只是为了不让人撞上「未知指令」
    const client = app.app.mock.client('10000')
    for (const alias of ['曲表', '分数表', '查询分数表']) {
      const before = app.requests.length
      await client.receive(alias)
      expect(app.requests.length - before, alias).toBe(1)
      expect(app.requests[app.requests.length - 1].url).toContain('/songMeta')
    }

    await client.receive('曲表 tw jp')
    expect(app.bodyFor('/songMeta')).toMatchObject({ displayedServerList: ['tw', 'jp'] })
  })

  it('曲效率只认服务器，多写的词明确报错而不是默默吞掉', async () => {
    const app = await createTestApp(router({ '/songMeta': IMAGE }))
    const before = app.requests.length
    expect((await app.app.mock.client('10000').receive('曲效率 迷星叫')).join('')).toContain('不接受查询词')
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('后端回域内错误文案时原样透出', async () => {
    const lonely = await createTestApp(router({ '/searchSong': NO_RESULT }))
    const replies = await lonely.app.mock.client('10000').receive('查曲 不存在的歌')
    expect(replies.join('')).toContain('没有搜索到符合条件的歌曲')
    await lonely.dispose()
  })
})

describe('查谱面 / 谱面数据', () => {
  it('用歌名查谱面：一步交给 /songChart（不再先调 /fuzzySearch）', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    const replies = await app.app.mock.client('10000').receive('查谱面 诗超绊 ex')

    expect(app.requests).toHaveLength(1)
    expect(app.requests[0].url).toContain('/songChart')
    // 难度后缀必须已经剥掉，否则会污染搜索词
    expect(app.bodyOf(0)).toEqual({
      displayedServerList: ALL_SERVERS,
      id: '诗超绊',
      difficultyId: 3,
      mirror: false,
      compress: true,
    })
    expect(replies[0]).toContain('<img')
    await app.dispose()
  })

  it('用数字 ID 查谱面同样一步直达（纯数字串后端按 ID 处理）', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    await app.app.mock.client('10000').receive('查谱面 100008 ez')

    expect(app.requests).toHaveLength(1)
    expect(app.requests[0].url).toContain('/songChart')
    expect(app.bodyOf(0)).toMatchObject({ id: '100008', difficultyId: 0 })
    await app.dispose()
  })

  it('服务器写在 ID 前面也认（逐 token 分类而不是剥尾部）', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    await app.app.mock.client('10000').receive('查谱面 jp 100008')
    expect(app.requests).toHaveLength(1)
    expect(app.bodyOf(0)).toMatchObject({ id: '100008', displayedServerList: ['jp'] })
    await app.dispose()
  })

  it('不给难度时用 ex（difficultyId 3），与后端默认一致', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    await app.app.mock.client('10000').receive('查谱面 100008')
    expect(app.bodyOf(0)).toMatchObject({ difficultyId: 3 })
    await app.dispose()
  })

  it('速度两种写法都变成 noteSpeed；不写就不发这个字段', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查谱面 100008 ex 速度7.5')
    expect(app.bodyOf(0)).toMatchObject({ noteSpeed: 7.5 })
    expect(app.bodyOf(0)).not.toHaveProperty('speed')

    await client.receive('查谱面 100008 速度 10.5')
    expect(app.bodyOf(1)).toMatchObject({ noteSpeed: 10.5 })

    await client.receive('查谱面 100008')
    expect(app.bodyOf(2)).not.toHaveProperty('noteSpeed')
    await app.dispose()
  })

  it('速度越界本地拦下，不发必然 400 的请求', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    const replies = await app.app.mock.client('10000').receive('查谱面 100008 速度13')
    expect(app.requests).toHaveLength(0)
    expect(replies.join('')).toContain(MESSAGES.invalidNoteSpeed)
    await app.dispose()
  })

  it('sp 难度被拦下，不会发出必然 400 的请求', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    const replies = await app.app.mock.client('10000').receive('查谱面 诗超绊 sp')

    expect(app.requests).toHaveLength(0)
    expect(replies.join('')).toContain(MESSAGES.unsupportedSpecial)
    await app.dispose()
  })

  it('镜像修饰词（-m / 镜像）把 mirror=true 传给后端', async () => {
    // 贪心的 text 参数会吞掉 Koishi 的选项，所以插件是自己解析这个修饰词的
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查谱面 100008 ex -m')
    expect(app.bodyOf(0)).toMatchObject({ id: '100008', difficultyId: 3, mirror: true })

    await client.receive('查谱面 100008 镜像')
    expect(app.bodyOf(1)).toMatchObject({ id: '100008', mirror: true })

    // 顺序反过来也要认，且不能把难度一起吞掉
    await client.receive('查谱面 100008 镜像 ez')
    expect(app.bodyOf(2)).toMatchObject({ id: '100008', difficultyId: 0, mirror: true })

    await app.dispose()
  })

  it('修饰词与查询词混排：难度/镜像/流速照旧剥掉，认不出的词留在查询词里', async () => {
    const app = await createTestApp(router({ '/songChart': IMAGE }))
    await app.app.mock.client('10000').receive('查谱面 诗超绊 生日 ex 镜像 速度7.5 jp')
    expect(app.bodyOf(0)).toMatchObject({
      id: '诗超绊 生日',
      difficultyId: 3,
      mirror: true,
      noteSpeed: 7.5,
      displayedServerList: ['jp'],
    })
    await app.dispose()
  })

  it('连不上后端时透出连接错误，而不是误报「没找到歌」', async () => {
    const app = await createTestApp(() => { throw new Error('connect ECONNREFUSED') })
    const replies = await app.app.mock.client('10000').receive('查谱面 诗超绊')

    expect(replies.join('')).toContain(MESSAGES.backendUnavailable)
    await app.dispose()
  })

  it('谱面数据把 JSON 摘要成文字', async () => {
    const app = await createTestApp(router({
      '/songChartData': jsonSuccess({
        meta: {
          musicId: 100008,
          difficulty: 'expert',
          level: 26,
          title: '诗超绊',
          durationMs: 128002,
          laneCount: 24,
          counts: { Normal: 363, Flick: 124, SlideBegin: 84, Zero: 0 },
          bpm: [{ bpm: 190, timeStartMs: 0, timeEndMs: 108632 }, { bpm: 146.72999572753906, timeStartMs: 108632, timeEndMs: 128002 }],
          feverCount: 3,
          slideCount: 115,
        },
        simple: {},
      }),
    }))
    const replies = await app.app.mock.client('10000').receive('谱面数据 100008 ex')
    const text = replies.join('')

    expect(text).toContain('诗超绊')
    expect(text).toContain('expert')
    expect(text).toContain('Lv.26')
    expect(text).toContain('2:08')
    expect(text).toContain('190')
    expect(text).toContain('146.73')
    expect(text).toContain('普通 363')
    expect(text).toContain('Flick 124')
    // 0 值不该出现在摘要里
    expect(text).not.toContain('Zero')
    expect(app.bodyOf(0)).toEqual({
      displayedServerList: ALL_SERVERS,
      id: '100008',
      difficultyId: 3,
      mirror: false,
      format: 'simple',
    })
    await app.dispose()
  })

  it('谱面数据的 BPM 也能读 simple.bpm 那种 {segments, value} 形状', async () => {
    const app = await createTestApp(router({
      '/songChartData': jsonSuccess({
        meta: { musicId: 1, title: 'x', difficulty: 'expert' },
        simple: { bpm: { segments: [{ bpm: 180, timeStartMs: 0, timeEndMs: 1000 }], value: 180 } },
      }),
    }))
    const text = (await app.app.mock.client('10000').receive('谱面数据 1')).join('')
    expect(text).toContain('BPM: 180')
    await app.dispose()
  })

  it('谱面数据的 -m 生效（-m 由插件自己解析）', async () => {
    const app = await createTestApp(router({ '/songChartData': jsonSuccess({ meta: { title: 'x', musicId: 1, difficulty: 'expert' } }) }))
    const replies = await app.app.mock.client('10000').receive('谱面数据 100008 ex -m')
    expect(app.bodyOf(0)).toMatchObject({ mirror: true, difficultyId: 3 })
    expect(replies.join('')).toContain('镜像')
    await app.dispose()
  })

  it('谱面数据也能限定服务器', async () => {
    const app = await createTestApp(router({ '/songChartData': jsonSuccess({ meta: { title: 'x', musicId: 1, difficulty: 'expert' } }) }))
    await app.app.mock.client('10000').receive('谱面数据 100008 ex jp')
    expect(app.bodyOf(0)).toMatchObject({ displayedServerList: ['jp'] })
    await app.dispose()
  })

  it('谱面数据遇到后端失败时透出后端文案', async () => {
    const app = await createTestApp(router({ '/songChartData': jsonFailed('错误: 歌曲不存在') }))
    const replies = await app.app.mock.client('10000').receive('谱面数据 999999 ex')
    expect(replies.join('')).toContain('错误: 歌曲不存在')
    await app.dispose()
  })

  it('谱面数据的歌名与认不出的词都作为查询词发给后端（不再本地拦下）', async () => {
    const app = await createTestApp(router({
      '/songChartData': jsonFailed('错误: 匹配到多首歌曲, 请用 songId 精确指定: 100008 诗超绊'),
    }))
    const client = app.app.mock.client('10000')

    const replies = await client.receive('谱面数据 诗超绊')
    expect(app.bodyOf(0)).toMatchObject({ id: '诗超绊' })
    // 多命中时后端会给一句带候选 ID 的文案，插件原样透出
    expect(replies.join('')).toContain('请用 songId 精确指定')

    await client.receive('谱面数据 100008 xx')
    expect(app.bodyOf(1)).toMatchObject({ id: '100008 xx' })
    await app.dispose()
  })
})

describe('卡牌 / 卡池 / 贴纸 / 抽卡', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp(router({
      '/searchCard': IMAGE,
      '/searchMemberCard': IMAGE,
      '/searchSupportCard': IMAGE,
      '/getCardIllustration': IMAGE,
      '/searchGacha': IMAGE,
      '/getStampImage': IMAGE,
      '/gachaSimulate': IMAGE,
    }))
  })
  afterAll(() => app.dispose())

  it('三个查卡入口分别打到不同端点', async () => {
    const client = app.app.mock.client('10000')
    await client.receive('查卡 高松灯')
    await client.receive('查角色卡 高松灯')
    await client.receive('查支援卡 高松灯')
    expect(app.bodyFor('/searchCard')).toMatchObject({ id: '高松灯', displayedServerList: ALL_SERVERS })
    expect(app.bodyFor('/searchMemberCard')).toMatchObject({ id: '高松灯' })
    expect(app.bodyFor('/searchSupportCard')).toMatchObject({ id: '高松灯' })
  })

  it('整合入口的卡种词变成 cardType；固定入口不带这个字段', async () => {
    const client = app.app.mock.client('10000')
    await client.receive('查卡 高松灯 支援卡 jp')
    expect(app.bodyFor('/searchCard')).toEqual({
      displayedServerList: ['jp'],
      id: '高松灯',
      compress: true,
      cardType: 'support',
    })

    // 固定入口即使写了卡种也不发（后端不认）
    await client.receive('查角色卡 高松灯 支援卡')
    const body = app.bodyFor('/searchMemberCard') as Record<string, unknown>
    expect('cardType' in body).toBe(false)
  })

  it('查卡面默认不带 cardType（让后端 auto），id 走数字', async () => {
    await app.app.mock.client('10000').receive('查卡面 1001')
    expect(app.bodyFor('/getCardIllustration')).toEqual({
      displayedServerList: ALL_SERVERS,
      compress: true,
      id: 1001,
    })
  })

  it('查卡面的中文 cardType 别名会归一成后端认的值', async () => {
    await app.app.mock.client('10000').receive('查卡面 1001 支援卡 jp')
    expect(app.bodyFor('/getCardIllustration')).toEqual({
      displayedServerList: ['jp'],
      compress: true,
      id: 1001,
      cardType: 'support',
    })
  })

  it('别名 卡面 指向查卡面', async () => {
    await app.app.mock.client('10000').receive('卡面 1001')
    expect(app.bodyFor('/getCardIllustration')).toMatchObject({ id: 1001 })
  })

  it('查卡池走自己的端点、能限定服务器，也能按名字搜', async () => {
    const client = app.app.mock.client('10000')
    await client.receive('查卡池 1')
    expect(app.bodyFor('/searchGacha')).toEqual({ displayedServerList: ALL_SERVERS, id: '1', compress: true })

    await client.receive('查卡池 夏日祭 jp')
    expect(app.bodyFor('/searchGacha')).toMatchObject({ displayedServerList: ['jp'], id: '夏日祭' })
  })

  it('查贴纸三种用法：数字 ID / 关键词 / 全部', async () => {
    const client = app.app.mock.client('10000')

    await client.receive('查贴纸 5')
    expect(app.bodyFor('/getStampImage')).toEqual({
      displayedServerList: ALL_SERVERS,
      compress: true,
      id: 5,
    })

    await client.receive('查贴纸 高松灯 角色 jp')
    expect(app.bodyFor('/getStampImage')).toEqual({
      displayedServerList: ['jp'],
      compress: true,
      id: '高松灯',
      stampType: 'character',
    })

    await client.receive('查贴纸 全部 tw')
    expect(app.bodyFor('/getStampImage')).toEqual({
      displayedServerList: ['tw'],
      compress: true,
    })
  })

  it('查贴纸不带参数时给用法而不是 dump 一整页列表', async () => {
    const before = app.requests.length
    const replies = await app.app.mock.client('10000').receive('查贴纸')
    expect(app.requests.length - before).toBe(0)
    expect(replies.join('')).toContain('查贴纸 <数字ID>')
  })

  it('抽卡模拟默认 10 连、不带卡池（后端取当前开放卡池）', async () => {
    await app.app.mock.client('10000').receive('抽卡模拟')
    const body = app.bodyFor('/gachaSimulate') as Record<string, unknown>
    expect(body).toEqual({ displayedServerList: ['tw'], times: 10, compress: true })
    expect('id' in body).toBe(false)
  })

  it('抽卡模拟的位置参数：第一个是次数、第二个是卡池 ID，服务器可与它们混排', async () => {
    const client = app.app.mock.client('10000')

    await client.receive('抽卡模拟 30 2')
    expect(app.bodyFor('/gachaSimulate')).toEqual({ displayedServerList: ['tw'], times: 30, id: 2, compress: true })

    // 关键：以前 [times:number] 会把这条直接判为参数错误
    await client.receive('抽卡模拟 10 jp')
    expect(app.bodyFor('/gachaSimulate')).toEqual({
      displayedServerList: ['jp'],
      times: 10,
      compress: true,
    })
  })

  it('抽卡模拟的卡池也能写名字（文本只在该服索引里搜，多命中由后端回文案）', async () => {
    await app.app.mock.client('10000').receive('抽卡模拟 10 夏日祭 jp')
    expect(app.bodyFor('/gachaSimulate')).toEqual({
      displayedServerList: ['jp'],
      times: 10,
      id: '夏日祭',
      compress: true,
    })
  })

  it('抽卡次数非法（0 / 参数过多 / ID 与名字混排）本地拦下', async () => {
    const app2 = await createTestApp(router({ '/gachaSimulate': IMAGE }))
    const client = app2.app.mock.client('10000')
    expect((await client.receive('抽卡模拟 0')).join('')).toContain(MESSAGES.invalidTimes)
    expect((await client.receive('抽卡模拟 1 2 3')).join('')).toContain(MESSAGES.invalidTimes)
    expect((await client.receive('抽卡模拟 10 夏日祭 2')).join('')).toContain(MESSAGES.invalidTimes)
    expect(app2.requests).toHaveLength(0)
    await app2.dispose()
  })

  it('查卡面是唯一只收数字 ID 的卡类指令，非数字本地报错', async () => {
    const client = app.app.mock.client('10000')
    const before = app.requests.length
    expect((await client.receive('查卡面 abc')).join('')).toContain('数字')
    expect(app.requests.length - before).toBe(0)
  })

  it('未知的 cardType 明确报错，而不是静默忽略（否则会查错卡）', async () => {
    const before = app.requests.length
    const replies = await app.app.mock.client('10000').receive('查卡面 1001 乱写')
    expect(replies.join('')).toContain('卡片种类可选')
    expect(app.requests.length - before).toBe(0)
  })
})

describe('角色 / 活动', () => {
  it('查角色与查活动分别打到各自端点', async () => {
    const app = await createTestApp(router({ '/searchCharacter': IMAGE, '/searchEvent': NO_RESULT }))
    const client = app.app.mock.client('10000')
    await client.receive('查角色 千早爱音')
    await client.receive('查活动 某活动 jp')
    expect(app.bodyFor('/searchCharacter')).toMatchObject({ id: '千早爱音', displayedServerList: ALL_SERVERS })
    expect(app.bodyFor('/searchEvent')).toMatchObject({ id: '某活动', displayedServerList: ['jp'] })
    await app.dispose()
  })

  it('活动歌榜与活动推荐是单服端点，服务器走单值列表，参数按顺序解析', async () => {
    const app = await createTestApp(router({ '/eventSongRanking': IMAGE, '/eventRecommend': IMAGE }))
    const client = app.app.mock.client('10000')

    // 什么都不写 -> 前十 + 当前活动
    await client.receive('活动歌榜')
    expect(app.bodyFor('/eventSongRanking')).toEqual({ displayedServerList: ['tw'], compress: true })

    // 第一个数字是名次
    await client.receive('活动歌榜 100')
    expect(app.bodyFor('/eventSongRanking')).toEqual({ displayedServerList: ['tw'], rank: 100, compress: true })

    // 第二个数字才是活动 ID
    await client.receive('活动歌榜 100 123 jp')
    expect(app.bodyFor('/eventSongRanking')).toEqual({
      displayedServerList: ['jp'],
      rank: 100,
      id: 123,
      compress: true,
    })

    await client.receive('活动推荐')
    expect(app.bodyFor('/eventRecommend')).toEqual({ displayedServerList: ['tw'], compress: true })

    await client.receive('活动推荐 456 jp')
    expect(app.bodyFor('/eventRecommend')).toEqual({ displayedServerList: ['jp'], id: 456, compress: true })
    await app.dispose()
  })

  it('活动也能写名字：名字与名次/服务器混排时照样认', async () => {
    const app = await createTestApp(router({ '/eventSongRanking': IMAGE, '/eventRecommend': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('活动歌榜 100 夏日祭 jp')
    expect(app.bodyFor('/eventSongRanking')).toEqual({
      displayedServerList: ['jp'],
      rank: 100,
      id: '夏日祭',
      compress: true,
    })

    await client.receive('活动推荐 夏日祭')
    expect(app.bodyFor('/eventRecommend')).toEqual({ displayedServerList: ['tw'], id: '夏日祭', compress: true })
    await app.dispose()
  })

  it('旧名 活动榜线 与别名 推荐曲 仍然可用', async () => {
    const app = await createTestApp(router({ '/eventSongRanking': IMAGE, '/eventRecommend': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('活动榜线')
    expect(app.requests[app.requests.length - 1].url).toContain('/eventSongRanking')

    await client.receive('推荐曲')
    expect(app.requests[app.requests.length - 1].url).toContain('/eventRecommend')
    await app.dispose()
  })

  it('多出来的参数本地拦下，不发请求', async () => {
    const app = await createTestApp(router({ '/eventSongRanking': IMAGE, '/eventRecommend': IMAGE }))
    const client = app.app.mock.client('10000')
    const before = app.requests.length

    // 活动歌榜 收两个数字（名次 + 活动 ID），多出来不猜；ID 与活动名也不能同时给
    expect((await client.receive('活动歌榜 100 1 2')).join('')).toContain(MESSAGES.eventRankArgsOnly)
    expect((await client.receive('活动歌榜 100 1 夏日祭')).join('')).toContain(MESSAGES.eventRankArgsOnly)
    // 活动推荐 只收一个活动（ID 或名字）
    expect((await client.receive('活动推荐 1 2')).join('')).toContain(MESSAGES.eventIdOnly)
    expect((await client.receive('活动推荐 1 夏日祭')).join('')).toContain(MESSAGES.eventIdOnly)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('ycx 单档位：按顺序解析，不写名次时默认 100', async () => {
    const app = await createTestApp(router({ '/cutoffAll': IMAGE }))
    const client = app.app.mock.client('10000')

    // 不写名次 -> 默认 100
    await client.receive('ycx')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['tw'], rank: 100, compress: true })

    // 第一个数字是档位，第二个是活动 ID
    await client.receive('ycx 100 1')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['tw'], rank: 100, id: 1, compress: true })

    await client.receive('ycx 10 10')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['tw'], rank: 10, id: 10, compress: true })

    // 关键：1 不再因为「不在档位表里」被当成活动 ID —— 第一个数字永远是档位
    await client.receive('ycx 1 jp')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['jp'], rank: 1, compress: true })

    // 活动名同样能写在档位后面
    await client.receive('ycx 100 夏日祭')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['tw'], rank: 100, id: '夏日祭', compress: true })
    await app.dispose()
  })

  it('ycxall 画全部档位：不发 rank，第一个数字就是活动 ID', async () => {
    const app = await createTestApp(router({ '/cutoffAll': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('ycxall')
    const body = app.bodyFor('/cutoffAll') as Record<string, unknown>
    expect(body).toEqual({ displayedServerList: ['tw'], compress: true })
    expect('rank' in body).toBe(false)

    await client.receive('ycxall 100')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['tw'], id: 100, compress: true })

    await client.receive('ycxall 夏日祭 jp')
    expect(app.bodyFor('/cutoffAll')).toEqual({ displayedServerList: ['jp'], id: '夏日祭', compress: true })
    await app.dispose()
  })

  it('ycx / ycxall 的多余参数本地拦下，不发请求', async () => {
    const app = await createTestApp(router({ '/cutoffAll': IMAGE }))
    const client = app.app.mock.client('10000')
    const before = app.requests.length

    expect((await client.receive('ycx 100 1 2')).join('')).toContain(MESSAGES.cutoffArgsOnly)
    expect((await client.receive('ycx 100 1 夏日祭')).join('')).toContain(MESSAGES.cutoffArgsOnly)
    expect((await client.receive('ycxall 1 2')).join('')).toContain(MESSAGES.cutoffArgsOnly)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })
})

describe('查乐团', () => {
  it('乐团走多服一图，与其它静态实体一样', async () => {
    const app = await createTestApp(router({ '/searchBand': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查乐团 MyGO')
    expect(app.bodyFor('/searchBand')).toEqual({
      displayedServerList: ALL_SERVERS,
      id: 'MyGO',
      compress: true,
    })

    await client.receive('查乐团 1 jp')
    expect(app.bodyFor('/searchBand')).toMatchObject({ id: '1', displayedServerList: ['jp'] })
    await app.dispose()
  })

  it('不给乐团名时不发请求', async () => {
    const app = await createTestApp(router({ '/searchBand': IMAGE }))
    const before = app.requests.length
    expect((await app.app.mock.client('10000').receive('查乐团')).join('')).toContain(MESSAGES.emptyText)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })
})

describe('关键词', () => {
  it('新增/删除关键词把类型归一并组装出完整请求体', async () => {
    const app = await createTestApp(router({
      '/keyword/upload': jsonSuccess('已添加关键词：迷星叫'),
      '/keyword/delete': jsonSuccess('已删除该关键词'),
    }))
    const client = app.app.mock.client('10000')

    expect((await client.receive('新增关键词 歌曲 100001 迷星叫')).join('')).toContain('已添加关键词')
    expect(app.bodyFor('/keyword/upload')).toEqual({
      userId: '10000',
      entityType: 'song',
      entityId: 100001,
      keyword: '迷星叫',
    })

    // 中文别名归一成后端认的值（角色 与 角色卡 是两个不同的实体类型）
    await client.receive('新增关键词 角色 5 小灯')
    expect(app.bodyFor('/keyword/upload')).toMatchObject({ entityType: 'character', entityId: 5 })

    await client.receive('新增关键词 支援卡 7 那张')
    expect(app.bodyFor('/keyword/upload')).toMatchObject({ entityType: 'supportCard' })

    await client.receive('新增关键词 乐团 3 小生物')
    expect(app.bodyFor('/keyword/upload')).toMatchObject({ entityType: 'band', entityId: 3 })

    await client.receive('删除关键词 角色卡 9 阿农')
    expect(app.bodyFor('/keyword/delete')).toEqual({
      userId: '10000',
      entityType: 'card',
      entityId: 9,
      keyword: '阿农',
    })
    await app.dispose()
  })

  it('关键词可以带空格', async () => {
    const app = await createTestApp(router({ '/keyword/upload': jsonSuccess('ok') }))
    await app.app.mock.client('10000').receive('新增关键词 歌曲 100001 迷 星 叫')
    expect(app.bodyFor('/keyword/upload')).toMatchObject({ keyword: '迷 星 叫' })
    await app.dispose()
  })

  it('类型/ID/关键词任一不合法都在本地拦下', async () => {
    const app = await createTestApp(router({ '/keyword/upload': jsonSuccess('ok') }))
    const client = app.app.mock.client('10000')
    const before = app.requests.length

    expect((await client.receive('新增关键词 火星 1 x')).join('')).toContain(MESSAGES.invalidKeywordType)
    expect((await client.receive('新增关键词 歌曲 abc x')).join('')).toContain(MESSAGES.invalidKeywordEntityId)
    expect((await client.receive('新增关键词 歌曲 0 x')).join('')).toContain(MESSAGES.invalidKeywordEntityId)
    expect((await client.receive('新增关键词 歌曲 1')).join('')).toContain(MESSAGES.missingKeyword)
    expect((await client.receive(`新增关键词 歌曲 1 ${'x'.repeat(33)}`)).join('')).toContain(MESSAGES.keywordTooLong)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('未启用数据库时把后端文案透出', async () => {
    const app = await createTestApp(() => httpError(404, { status: 'fail', data: '错误: 服务器未启用数据库' }))
    const replies = await app.app.mock.client('10000').receive('新增关键词 歌曲 1 测试')
    expect(replies.join('')).toContain('错误: 服务器未启用数据库')
    await app.dispose()
  })
})

describe('排行 / 玩家', () => {
  it('查排行是单服端点：服务器走单值列表，默认 tw', async () => {
    const app = await createTestApp(router({ '/songRanking': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查排行 100001')
    expect(app.bodyFor('/songRanking')).toEqual({ displayedServerList: ['tw'], id: '100001', compress: true })

    await client.receive('查排行 100001 jp')
    expect(app.bodyFor('/songRanking')).toEqual({ displayedServerList: ['jp'], id: '100001', compress: true })
    await app.dispose()
  })

  it('查排行也能传歌名（只在该服索引里搜），空查询词被拦下', async () => {
    const app = await createTestApp(router({ '/songRanking': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查排行 迷星叫 jp')
    expect(app.bodyFor('/songRanking')).toEqual({ displayedServerList: ['jp'], id: '迷星叫', compress: true })

    // 只写服务器（多个 token 全被剥光）时不发请求，直接提示缺查询词
    const before = app.requests.length
    expect((await client.receive('查排行 tw jp')).join('')).toContain(MESSAGES.emptyText)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('查玩家不写服务器时请求体里根本没有 displayedServerList，交给后端按 ID 首位推断', async () => {
    const app = await createTestApp(router({ '/searchPlayer': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查玩家 2000000000')
    const body = app.bodyFor('/searchPlayer') as Record<string, unknown>
    expect(body).toEqual({ playerId: '2000000000', compress: true })
    expect('displayedServerList' in body).toBe(false)

    // 日服没有前缀规则，必须显式指定
    await client.receive('查玩家 1234567890 jp')
    expect(app.bodyFor('/searchPlayer')).toEqual({ playerId: '1234567890', displayedServerList: ['jp'], compress: true })
    await app.dispose()
  })

  it('查玩家省略 ID 时带 userId（后端取默认绑定），不带玩家字段也不带服务器', async () => {
    const app = await createTestApp(router({ '/searchPlayer': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('查玩家')
    const body = app.bodyFor('/searchPlayer') as Record<string, unknown>
    expect(body).toEqual({ userId: '10000', compress: true })
    expect('playerId' in body).toBe(false)
    expect('displayedServerList' in body).toBe(false)
    await app.dispose()
  })

  it('查玩家只收一个查询词：多写数字给出提示而不是发请求', async () => {
    const app = await createTestApp(router({ '/searchPlayer': IMAGE }))
    const before = app.requests.length
    const text = (await app.app.mock.client('10000').receive('查玩家 2000000000 3000000000')).join('')
    expect(text).toContain(MESSAGES.playerIdOnlyOne)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('别名 查账号 指向查玩家', async () => {
    const app = await createTestApp(router({ '/searchPlayer': IMAGE }))
    await app.app.mock.client('10000').receive('查账号 2000000000')
    expect(app.bodyFor('/searchPlayer')).toMatchObject({ playerId: '2000000000' })
    await app.dispose()
  })
})

describe('发名片 / b25 / 组卡 / 绑定管理', () => {
  it('发名片：带 ID 时按首位推断服务器，不写服务器也把字段补上（后端这三条不自己推断）', async () => {
    const app = await createTestApp(router({ '/playerCard': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('发名片 3000000000')
    expect(app.bodyFor('/playerCard')).toEqual({ playerId: '3000000000', displayedServerList: ['en'], compress: true })

    // 用户写了服务器就用用户的，推断让位
    await client.receive('发名片 2000000000 jp')
    expect(app.bodyFor('/playerCard')).toEqual({ playerId: '2000000000', displayedServerList: ['jp'], compress: true })
    await app.dispose()
  })

  it('发名片：页码写成「页2」，省略 ID 时带 userId', async () => {
    const app = await createTestApp(router({ '/playerCard': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('发名片 2000000000 页2')
    expect(app.bodyFor('/playerCard')).toEqual({ playerId: '2000000000', page: 2, displayedServerList: ['tw'], compress: true })

    await client.receive('发名片')
    expect(app.bodyFor('/playerCard')).toEqual({ userId: '10000', compress: true })
    await app.dispose()
  })

  it('b25：缺省用绑定账号，带 ID 时补上推断出的服务器', async () => {
    const app = await createTestApp(router({ '/b25': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('b25')
    expect(app.bodyFor('/b25')).toEqual({ userId: '10000', compress: true })

    await client.receive('b25 4000000000')
    expect(app.bodyFor('/b25')).toEqual({ playerId: '4000000000', displayedServerList: ['kr'], compress: true })

    // 指令名不区分大小写：网页上写作「B25」，用户多半也这么敲
    await client.receive('B25')
    expect(app.bodyFor('/b25')).toEqual({ userId: '10000', compress: true })
    await app.dispose()
  })

  it('组卡：默认不发 mode（后端按 auto），模式词与活动 ID 按约定入体', async () => {
    const app = await createTestApp(router({ '/deckBuilder': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('组卡')
    expect(app.bodyFor('/deckBuilder')).toEqual({ userId: '10000', compress: true })

    await client.receive('组卡 常规 2000000000')
    expect(app.bodyFor('/deckBuilder')).toEqual({ playerId: '2000000000', mode: 'normal', displayedServerList: ['tw'], compress: true })

    // 「活动 123」：mode 与 eventId 一起给（后端拿到 eventId 也会强制活动模式）；
    // 没写玩家 ID 时只带 userId —— 服务器由绑定决定，不写这个字段
    await client.receive('组卡 活动 123')
    expect(app.bodyFor('/deckBuilder')).toEqual({ mode: 'event', eventId: 123, userId: '10000', compress: true })
    await app.dispose()
  })

  it('只写服务器不写玩家 ID 时明确报错（服务器由绑定决定，后端会静默忽略）', async () => {
    const app = await createTestApp(() => ok(textReply('不该被调用')))
    const client = app.app.mock.client('10000')
    const before = app.requests.length

    for (const command of ['查玩家 jp', '发名片 tw', 'b25 en', '组卡 活动 jp']) {
      expect((await client.receive(command)).join(''), command).toContain(MESSAGES.serverNeedsPlayerId)
    }
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('组卡：认不出的写法给出用法提示而不是发请求', async () => {
    const app = await createTestApp(router({ '/deckBuilder': IMAGE }))
    const before = app.requests.length
    const text = (await app.app.mock.client('10000').receive('组卡 高松灯')).join('')
    expect(text).toContain(MESSAGES.deckArgsUsage)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('绑定管理：绑定 / 列表 / 切换默认 / 解绑都只发 userId 与选择器', async () => {
    const app = await createTestApp(router({
      '/playerBind/bind': textReply('绑定成功: 测试账号'),
      '/playerBind/list': textReply('已绑定的游戏账号'),
      '/playerBind/use': textReply('默认账号已切换为'),
      '/playerBind/unbind': textReply('已解绑'),
    }))
    const client = app.app.mock.client('10000')

    await client.receive('绑定玩家 AB12CD34')
    expect(app.bodyFor('/playerBind/bind')).toEqual({ userId: '10000', code: 'AB12CD34' })

    await client.receive('玩家绑定')
    expect(app.bodyFor('/playerBind/list')).toEqual({ userId: '10000' })

    // 别名 玩家状态 也在（老 tsugu 习惯）
    await client.receive('玩家状态')
    expect(app.bodyFor('/playerBind/list')).toEqual({ userId: '10000' })

    await client.receive('默认玩家 2')
    expect(app.bodyFor('/playerBind/use')).toEqual({ userId: '10000', index: 2 })

    await client.receive('默认玩家 2000000000')
    expect(app.bodyFor('/playerBind/use')).toEqual({ userId: '10000', playerId: '2000000000' })

    await client.receive('解除绑定 1')
    expect(app.bodyFor('/playerBind/unbind')).toEqual({ userId: '10000', index: 1 })
    await app.dispose()
  })

  it('绑定管理：参数不合法（绑定码为空 / 序号 0）时给出提示而不是发请求', async () => {
    const app = await createTestApp(() => ok(textReply('不该被调用')))
    const client = app.app.mock.client('10000')
    const before = app.requests.length

    expect((await client.receive('默认玩家 0')).join('')).toContain(MESSAGES.bindSelectorUsage)
    expect((await client.receive('解除绑定 abc')).join('')).toContain(MESSAGES.bindSelectorUsage)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })
})

describe('公告', () => {
  it('公告列表默认 tw，可指定服务器', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const client = app.app.mock.client('10000')

    await client.receive('公告列表')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['tw'], compress: true })

    await client.receive('公告列表 jp')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['jp'], compress: true })
    await app.dispose()
  })

  it('公告列表只认服务器，多写的词明确报错', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const before = app.requests.length
    expect((await app.app.mock.client('10000').receive('公告列表 23')).join('')).toContain('参数无法识别')
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('公告 <ID> [服务器] 查详情；公告 tw 等价于订阅', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const client = app.app.mock.client('10000', '20000')

    await client.receive('公告 23')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['tw'], id: '23', compress: true })

    await client.receive('公告 23 jp')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['jp'], id: '23', compress: true })

    // 「最新」= 后端的 id -1 哨兵值（该服发布时间最新的一条）。
    // 裸 -1 会被 Koishi 当成选项吞掉（见下面那条测试），要写就写带引号的 "-1"
    await client.receive('公告 最新 jp')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['jp'], id: '-1', compress: true })

    await client.receive('公告 "-1"')
    expect(app.bodyFor('/announcements')).toEqual({ displayedServerList: ['tw'], id: '-1', compress: true })

    // 服务器词 → 订阅（不查后端）
    const before = app.requests.length
    const replies = await client.receive('公告 tw')
    expect(app.requests.length - before).toBe(0)
    expect(replies.join('')).toContain('已在本会话订阅公告推流：港澳台服')
    await app.dispose()
  })

  it('裸 -1 会被 Koishi 当选项吞掉：只回用法提示，不发请求（要写「最新」或带引号的 "-1"）', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const before = app.requests.length

    const text = (await app.app.mock.client('10000').receive('公告 -1')).join('')
    expect(text).toContain('公告 最新')
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('公告订阅 / 公告退订 明确指令，且退订只影响本会话', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const client = app.app.mock.client('10000', '20000')

    const subscribed = (await client.receive('公告订阅 tw jp')).join('')
    expect(subscribed).toContain('港澳台服、日服')
    // announcementStream 在测试里是关的，所以要提示一句收不到
    expect(subscribed).toContain(MESSAGES.subscriptionDisabled)

    expect((await client.receive('公告退订 jp')).join('')).toContain('已关闭本会话 [日服] 的公告推流')
    expect((await client.receive('公告退订 jp')).join('')).toContain('本会话没有订阅日服')

    expect((await client.receive('公告退订')).join('')).toContain('已关闭本会话全部公告推流')
    expect((await client.receive('公告退订')).join('')).toContain(MESSAGES.noSubscription)
    await app.dispose()
  })

  it('公告订阅必须写服务器', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const replies = await app.app.mock.client('10000', '20000').receive('公告订阅')
    expect(replies.join('')).toContain(MESSAGES.missingSubscribeServer)
    await app.dispose()
  })

  it('公告不带参数时给用法', async () => {
    const app = await createTestApp(router({ '/announcements': IMAGE }))
    const replies = await app.app.mock.client('10000', '20000').receive('公告')
    expect(replies.join('')).toContain('公告 <公告ID>')
    await app.dispose()
  })
})

describe('公告推流接线', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('announcementStream 打开时：没订阅不连，订阅后才去连对应服的推流端点', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tomori-wire-'))
    dirs.push(dir)

    // 永不结束的流：让 manager 保持「已连接」，收尾时由 fork.dispose() 断掉。
    // 每条连接都要给一个新的流对象 —— 同一个流被两次 getReader() 会直接锁死
    const app = await createTestApp((request) => {
      if (request.url.includes('/announcementStream/')) {
        return { ...ok(null), data: new ReadableStream<Uint8Array>({ start() { /* 不推任何数据 */ } }) }
      }
      return ok(textReply('不该被调用'))
    }, { announcementStream: true, subscriptionFile: join(dir, 'subscriptions.json') })

    // 没有任何订阅时一条连接都不该建 —— 否则后端会一直替我们轮询上游
    expect(app.requests.filter(r => r.url.includes('/announcementStream/'))).toHaveLength(0)

    const client = app.app.mock.client('10000', '20000')
    expect((await client.receive('公告订阅 tw jp')).join('')).toContain('已在本会话订阅公告推流')

    const opened = app.requests.filter(r => r.url.includes('/announcementStream/'))
    expect(opened.map(r => r.url)).toEqual([
      'http://backend.test/announcementStream/tw',
      'http://backend.test/announcementStream/jp',
    ])
    // SSE 必须显式关掉超时并声明流式响应，否则会被 http 服务掐断 / 拿不到 body
    expect(opened[0].method).toBe('get')
    expect(opened[0].timeout).toBe(0)
    expect(opened[0].responseType).toBe('stream')

    // 订阅落盘了
    const saved = JSON.parse(await readFile(join(dir, 'subscriptions.json'), 'utf-8'))
    expect(saved.channels['mock:20000'].servers).toEqual(['tw', 'jp'])

    // 退订后连接被断掉（收尾时 manager.stop() 也会清干净）
    expect((await client.receive('公告退订')).join('')).toContain('已关闭本会话全部公告推流')

    await app.dispose()
  })
})

describe('车站', () => {
  it('车来自带 ycm / 有车吗 别名，并让后端自己查库', async () => {
    const app = await createTestApp(router({ '/roomList': IMAGE }))
    const client = app.app.mock.client('10000')

    expect((await client.receive('车来')).length).toBeGreaterThan(0)
    expect((await client.receive('ycm')).length).toBeGreaterThan(0)
    expect((await client.receive('有车吗')).length).toBeGreaterThan(0)

    // 不传 roomList —— 后端 /roomList 无入参时直接查库出图
    expect(app.bodyFor('/roomList')).toEqual({ compress: true })
    await app.dispose()
  })

  it('上传车牌组装出后端要的完整请求体', async () => {
    const app = await createTestApp(router({ '/station/submitRoomNumber': jsonSuccess('提交成功') }))
    // 有频道 → 群聊；mock 的 user.name 就是 userId
    const replies = await app.app.mock.client('10000', '20000').receive('上传车牌 123456 上车')
    const body = app.bodyFor('/station/submitRoomNumber') as Record<string, unknown>

    expect(body).toMatchObject({
      number: 123456,
      rawMessage: '123456 上车',
      platform: 'mock',
      userId: '10000',
      userName: '10000',
    })
    // 后端用 time 算「x 秒前」，必须是毫秒时间戳（参考项目传的 120 是 bug）
    expect(typeof body.time).toBe('number')
    expect(body.time as number).toBeGreaterThan(1_600_000_000_000)
    // mock 的事件里没有头像，不该塞个 undefined 进去
    expect('avatarUrl' in body).toBe(false)
    expect(replies.join('')).toContain('提交成功')
    await app.dispose()
  })

  it('房号位数不对时本地拦下，不发请求', async () => {
    const app = await createTestApp(router({ '/station/submitRoomNumber': jsonSuccess('提交成功') }))
    const before = app.requests.length
    const replies = await app.app.mock.client('10000').receive('上传车牌 1234 上车')
    expect(replies.join('')).toContain(MESSAGES.invalidRoomNumber)
    expect(app.requests.length - before).toBe(0)
    await app.dispose()
  })

  it('7 位房号被接受，且原样发给后端（不被截断）', async () => {
    const app = await createTestApp(router({ '/station/submitRoomNumber': jsonSuccess('提交成功') }))
    const replies = await app.app.mock.client('10000').receive('上传车牌 1234567 上车')
    expect(app.bodyFor('/station/submitRoomNumber')).toMatchObject({ number: 1234567, rawMessage: '1234567 上车' })
    expect(replies.join('')).toContain('提交成功')
    await app.dispose()
  })

  it('位数超了（8 位）也不会被悄悄截断', async () => {
    const app = await createTestApp(router({ '/station/submitRoomNumber': jsonSuccess('提交成功') }))
    const replies = await app.app.mock.client('10000').receive('上传车牌 12345678 上车')
    expect(replies.join('')).toContain(MESSAGES.invalidRoomNumber)
    expect(app.requests).toHaveLength(0)
    await app.dispose()
  })

  it('未启用数据库时把后端文案透出给用户', async () => {
    const app = await createTestApp(() => httpError(404, { status: 'fail', data: '错误: 服务器未启用数据库' }))
    const replies = await app.app.mock.client('10000').receive('车来')
    expect(replies.join('')).toContain('错误: 服务器未启用数据库')
    await app.dispose()
  })
})

describe('交友', () => {
  it('交友登记把服务器别名归一成短码，playerId 以字符串发（后端要求）', async () => {
    const app = await createTestApp(router({ '/friend/upload': jsonSuccess('已记录你的交友信息') }))
    const client = app.app.mock.client('10000')

    await client.receive('交友登记 9876543210')
    expect(app.bodyFor('/friend/upload')).toEqual({
      userId: '10000',
      userName: '10000',
      playerId: '9876543210',
      server: 'tw',   // 省略时默认港澳台服（短码，不再是 hk-tw-mo 别名）
    })

    await client.receive('交友登记 9876543210 日服')
    expect(app.bodyFor('/friend/upload')).toMatchObject({ server: 'jp' })
    await app.dispose()
  })

  it('非数字游戏 ID 与未知服务器都本地拦下', async () => {
    const app = await createTestApp(router({ '/friend/upload': jsonSuccess('ok') }))
    const client = app.app.mock.client('10000')

    expect((await client.receive('交友登记 abc')).join('')).toContain(MESSAGES.invalidPlayerId)
    expect((await client.receive('交友登记 123 火星服')).join('')).toContain('服务器只支持')
    expect(app.requests).toHaveLength(0)
    await app.dispose()
  })

  it('解除交友（别名 删除交友）与交友列表', async () => {
    const app = await createTestApp(router({
      '/friend/delete': jsonSuccess('已删除你的交友信息'),
      '/friend/list': IMAGE,
    }))
    const client = app.app.mock.client('10000')

    expect((await client.receive('解除交友')).join('')).toContain('已删除')
    expect(app.bodyFor('/friend/delete')).toEqual({ userId: '10000' })

    expect((await client.receive('删除交友')).join('')).toContain('已删除')

    await client.receive('交友列表')
    expect(app.bodyFor('/friend/list')).toEqual({ compress: true })
    await app.dispose()
  })
})

describe('后端状态', () => {
  it('用 GET 打 /health 并展示四服版本与玩家数据源', async () => {
    const app = await createTestApp(router({
      '/health': jsonSuccess({
        ok: true,
        defaultServer: 'tw',
        servers: ['tw', 'jp', 'kr', 'en'],
        regions: {
          tw: { version: 'abc123', resourceVersion: '1.0.0.105' },
          jp: { version: 'def456', resourceVersion: '1.0.0.300' },
        },
        playerGateway: false,
        upTimeS: 3700,
      }),
    }))
    const replies = await app.app.mock.client('10000').receive('后端状态')
    const text = replies.join('')

    expect(app.requests[0].method).toBe('get')
    expect(app.requests[0].url).toContain('/health')
    expect(text).toContain('缺省区域: tw')
    expect(text).toContain('港澳台服: abc123 / 1.0.0.105')
    expect(text).toContain('日服: def456 / 1.0.0.300')
    expect(text).toContain('站点公开接口')
    expect(text).toContain('1 小时')
    await app.dispose()
  })

  it('配了自建网关时如实说明', async () => {
    const app = await createTestApp(router({ '/health': jsonSuccess({ ok: true, playerGateway: true, regions: {} }) }))
    expect((await app.app.mock.client('10000').receive('后端状态')).join('')).toContain('自建网关')
    await app.dispose()
  })

  it('后端是旧契约（/health 没有四区域列表）时提示版本不符与回退办法', async () => {
    const app = await createTestApp(router({
      '/health': jsonSuccess({ ok: true, region: 'tw', playerGateway: false, dataVersion: 'old' }),
    }))
    const text = (await app.app.mock.client('10000').receive('后端状态')).join('')

    expect(text).toContain('不是本插件对应的契约版本')
    expect(text).toContain('koishi-plugin-tomori-ournotes@1.0.0')
    await app.dispose()
  })

  it('后端不可达时说清楚连不上哪个地址', async () => {
    const app = await createTestApp(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:3002') })
    const text = (await app.app.mock.client('10000').receive('后端状态')).join('')
    expect(text).toContain(MESSAGES.backendUnavailable)
    expect(text).toContain('/health')
    expect(text).toContain('ECONNREFUSED')
    await app.dispose()
  })
})

describe('占位桩指令', () => {
  it('tsugu 有但后端没实现的指令回复统一提示，且不发请求', async () => {
    const app = await createTestApp(() => ok(textReply('不该被调用')))
    const client = app.app.mock.client('10000')

    for (const command of ['lsycx', '查试炼', '逮捕 @x', '查自制谱 1']) {
      const text = (await client.receive(command)).join('')
      expect(text, command).toContain(MESSAGES.stubPrefix)
    }
    expect(app.requests).toHaveLength(0)
    await app.dispose()
  })

  it('绑定管理不再是桩：玩家绑定 / 绑定玩家 走真端点', async () => {
    const app = await createTestApp(router({
      '/playerBind/list': textReply('已绑定的游戏账号'),
      '/playerBind/bind': textReply('绑定成功'),
    }))
    const client = app.app.mock.client('10000')

    const list = (await client.receive('玩家绑定')).join('')
    expect(list).not.toContain(MESSAGES.stubPrefix)

    const bind = (await client.receive('绑定玩家 AB12CD34')).join('')
    expect(bind).not.toContain(MESSAGES.stubPrefix)
    expect(app.requests).toHaveLength(2)
    await app.dispose()
  })

  it('ycx / ycxall 已经是真指令，不再回占位文案', async () => {
    // 后端的 /cutoffAll 已经是真正的榜线端点（各档分数线随时间的折线图）
    const app = await createTestApp(router({ '/cutoffAll': IMAGE }))
    const client = app.app.mock.client('10000')

    for (const command of ['ycx', 'ycxall']) {
      const text = (await client.receive(command)).join('')
      expect(text, command).not.toContain(MESSAGES.stubPrefix)
    }
    expect(app.requests).toHaveLength(2)
    await app.dispose()
  })

  it('「查玩家」已经是真指令，不再回占位文案', async () => {
    const app = await createTestApp(router({ '/searchPlayer': IMAGE }))
    const text = (await app.app.mock.client('10000').receive('查玩家 10000000')).join('')
    expect(text).not.toContain(MESSAGES.stubPrefix)
    expect(app.requests).toHaveLength(1)
    await app.dispose()
  })

  it('stubCommands=false 时这些指令不再存在', async () => {
    // 用一个仍然是桩的指令当样例（「查玩家」「玩家绑定」已经实现了，拿它们会因为错误的原因通过）
    const app = await createTestApp(() => ok(textReply('不该被调用')), { stubCommands: false })
    const text = (await app.app.mock.client('10000').receive('lsycx')).join('')
    expect(text).not.toContain(MESSAGES.stubPrefix)
    await app.dispose()
  })
})

describe('消息设置：reply / at / compress', () => {
  it('reply 与 at 打开时，回复里带上引用与 @', async () => {
    const app = await createTestApp(router({ '/searchSong': IMAGE }), { reply: true, at: true })
    const replies = await app.app.mock.client('10000').receive('查曲 诗超绊')
    const text = replies.join('')

    expect(text).toContain('<quote')
    expect(text).toContain('<at')
    expect(text).toContain('10000')
    await app.dispose()
  })

  it('关闭时不加引用与 @', async () => {
    const app = await createTestApp(router({ '/searchSong': IMAGE }), { reply: false, at: false })
    const text = (await app.app.mock.client('10000').receive('查曲 诗超绊')).join('')
    expect(text).not.toContain('<quote')
    expect(text).not.toContain('<at')
    await app.dispose()
  })

  it('compress=false 会透传到请求体（后端据此出 PNG）', async () => {
    const app = await createTestApp(router({ '/searchSong': IMAGE }), { compress: false })
    await app.app.mock.client('10000').receive('查曲 诗超绊')
    expect(app.bodyFor('/searchSong')).toMatchObject({ compress: false })
    await app.dispose()
  })

  it('defaultServers / defaultServer 可配置', async () => {
    const app = await createTestApp(router({ '/searchSong': IMAGE, '/songRanking': IMAGE }), {
      defaultServers: ['jp'],
      defaultServer: 'jp',
    })
    const client = app.app.mock.client('10000')
    await client.receive('查曲 诗超绊')
    expect(app.bodyFor('/searchSong')).toMatchObject({ displayedServerList: ['jp'] })
    await client.receive('查排行 100001')
    expect(app.bodyFor('/songRanking')).toMatchObject({ displayedServerList: ['jp'] })
    await app.dispose()
  })
})

describe('后端地址与容错', () => {
  it('主地址连不上时按顺序重试备用地址', async () => {
    const app = await createTestApp((request) => {
      if (request.url.startsWith('http://backend.test')) throw new Error('connect ECONNREFUSED')
      return ok(IMAGE)
    }, { backupURLs: ['http://backup.test'] })

    const replies = await app.app.mock.client('10000').receive('查曲 诗超绊')
    expect(app.requests).toHaveLength(2)
    expect(app.requests[0].url).toContain('backend.test')
    expect(app.requests[1].url).toContain('backup.test')
    expect(replies[0]).toContain('<img')
    await app.dispose()
  })

  it('后端返回 5xx 时不切换备用地址（那是业务答复，不是连不上）', async () => {
    const app = await createTestApp(() => httpError(500, { status: 'failed', data: '内部错误' }), {
      backupURLs: ['http://backup.test'],
    })
    const replies = await app.app.mock.client('10000').receive('查曲 诗超绊')
    expect(app.requests).toHaveLength(1)
    expect(replies.join('')).toContain('内部错误')
    await app.dispose()
  })

  it('请求带上配置的超时，并显式接管状态码判断', async () => {
    const app = await createTestApp(router({ '/searchSong': IMAGE }), { requestTimeout: 12345 })
    await app.app.mock.client('10000').receive('查曲 诗超绊')
    // validateStatus 必须由插件提供：Koishi 默认只在 status<400 时不抛错，
    // 而后端的域内错误是 404/400，需要拿到响应体才能把文案取出来
    expect(app.requests[0].timeout).toBe(12345)
    expect(app.requests[0].validateStatus?.(404)).toBe(true)
    expect(app.requests[0].validateStatus?.(500)).toBe(true)
    await app.dispose()
  })

  it('全部地址都连不上时给出统一提示', async () => {
    const app = await createTestApp(() => { throw new Error('ENOTFOUND') }, { backupURLs: ['http://backup.test'] })
    const text = (await app.app.mock.client('10000').receive('查曲 诗超绊')).join('')
    expect(text).toContain(MESSAGES.backendUnavailable)
    await app.dispose()
  })
})
