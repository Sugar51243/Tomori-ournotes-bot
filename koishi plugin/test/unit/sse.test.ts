/**
 * SSE 解析的单测。
 *
 * 样例取自后端真实抓包 `Tomori-ournotes-bot/scripts/selftest-artifacts/sse-tw.log`
 * （只把超长的 base64 换成占位串）。
 */
import { describe, expect, it } from 'vitest'
import { announcementHeader, createSseParser, decodeAnnouncementEvent } from '../../src/stream/sse'

/** 把一串文本切成固定长度的块喂进去，模拟网络分片 */
function feed(chunks: string[]): ReturnType<ReturnType<typeof createSseParser>['push']> {
  const parser = createSseParser()
  const events: ReturnType<typeof parser.push> = []
  for (const chunk of chunks) events.push(...parser.push(chunk))
  events.push(...parser.flush())
  return events
}

const READY = 'event: ready\ndata: {"server":"tw","pollSeconds":300}\n\n'
const ANNOUNCEMENT = 'event: announcement\ndata: {"server":"tw","kind":"added","id":"4","title":"版本更新公告","category":"UPDATE","updatedAt":"1790800000","images":[{"type":"base64","string":"QUJD"}]}\n\n'

describe('createSseParser', () => {
  it('解析握手事件与公告事件', () => {
    const events = feed([READY + ANNOUNCEMENT])
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ event: 'ready', data: '{"server":"tw","pollSeconds":300}' })
    expect(events[1].event).toBe('announcement')
    expect(JSON.parse(events[1].data).kind).toBe('added')
  })

  it('丢弃注释行（后端拿它做心跳）', () => {
    const events = feed([': ping\n\n', READY, ': ping\n', ': ping\n\n', ANNOUNCEMENT])
    expect(events.map(e => e.event)).toEqual(['ready', 'announcement'])
  })

  it('能跨 chunk 拼接半行 —— 网络分片跟行边界没关系', () => {
    const whole = READY + ANNOUNCEMENT
    // 逐字节切碎，最坏情况
    const chunks = [...whole].map(c => c)
    expect(feed(chunks).map(e => e.event)).toEqual(['ready', 'announcement'])
  })

  it('一次 chunk 里多个事件也全吐出来', () => {
    expect(feed([READY + ANNOUNCEMENT + ANNOUNCEMENT])).toHaveLength(3)
  })

  it('兼容 CRLF', () => {
    const events = feed([READY.replace(/\n/g, '\r\n')])
    expect(events).toEqual([{ event: 'ready', data: '{"server":"tw","pollSeconds":300}' }])
  })

  it('多行 data 按规范用 \\n 拼起来', () => {
    const events = feed(['event: x\ndata: a\ndata: b\n\n'])
    expect(events).toEqual([{ event: 'x', data: 'a\nb' }])
  })

  it('没有事件名时按规范当成 message', () => {
    expect(feed(['data: hello\n\n'])).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('空 data 的自定义事件也算一个事件（flush 时不会漏）', () => {
    expect(feed(['event: ready\ndata: \n\n'])).toEqual([{ event: 'ready', data: '' }])
  })

  it('流结束时残留缓冲里的最后一条也吐出来', () => {
    // 有些服务端最后不加空行
    const parser = createSseParser()
    expect(parser.push('event: ready\ndata: {}\n')).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'ready', data: '{}' }])
  })

  it('空 chunk 不产生事件', () => {
    expect(feed(['', '\n', '\n\n'])).toEqual([])
  })
})

describe('decodeAnnouncementEvent', () => {
  const payload = {
    server: 'tw',
    kind: 'updated',
    id: '1',
    title: '紧急维护公告',
    category: 'MAINTENANCE',
    updatedAt: '1790999999',
    images: [{ type: 'base64', string: 'QUJD' }, { type: 'string', string: '附注' }],
  }

  it('解出后端真实形状的载荷', () => {
    expect(decodeAnnouncementEvent(JSON.stringify(payload))).toEqual({
      server: 'tw',
      kind: 'updated',
      id: '1',
      title: '紧急维护公告',
      category: 'MAINTENANCE',
      updatedAt: '1790999999',
      images: [{ type: 'base64', string: 'QUJD' }, { type: 'string', string: '附注' }],
    })
  })

  it('kind 缺省或未知时按新增处理', () => {
    expect(decodeAnnouncementEvent(JSON.stringify({ ...payload, kind: undefined }))?.kind).toBe('added')
    expect(decodeAnnouncementEvent(JSON.stringify({ ...payload, kind: 'removed' }))?.kind).toBe('added')
  })

  it('解析失败 / 形状不对时返回 undefined 而不是抛错', () => {
    expect(decodeAnnouncementEvent('{不是 JSON')).toBeUndefined()
    expect(decodeAnnouncementEvent('[]')).toBeUndefined()
    expect(decodeAnnouncementEvent('null')).toBeUndefined()
  })

  it('服务器认不出来、或既没标题也没内容时跳过', () => {
    expect(decodeAnnouncementEvent(JSON.stringify({ ...payload, server: '火星' }))).toBeUndefined()
    expect(decodeAnnouncementEvent(JSON.stringify({ ...payload, title: '', images: [] }))).toBeUndefined()
  })

  it('images 里的畸形项被跳过，不牵连整条载荷', () => {
    const decoded = decodeAnnouncementEvent(JSON.stringify({
      ...payload,
      images: [null, 42, { type: 'base64' }, { type: 'base64', string: 'QUJD' }, { type: '未知', string: 'x' }],
    }))
    expect(decoded?.images).toEqual([{ type: 'base64', string: 'QUJD' }])
  })
})

describe('announcementHeader', () => {
  it('新增与更新用不同的动词', () => {
    const base = { server: 'tw', id: '4', images: [] } as const
    expect(announcementHeader({ ...base, kind: 'added', title: '版本更新' })).toBe('【港澳台服】公告新增：版本更新')
    expect(announcementHeader({ ...base, kind: 'updated', title: '版本更新' })).toBe('【港澳台服】公告更新：版本更新')
  })

  it('没有标题时退回公告 ID', () => {
    expect(announcementHeader({ server: 'jp', kind: 'added', id: '9', title: '', images: [] }))
      .toBe('【日服】公告新增：#9')
  })
})
