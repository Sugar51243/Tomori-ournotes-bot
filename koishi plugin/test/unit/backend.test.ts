/**
 * HTTP 层与响应渲染的单测。
 * 这里不经过 Koishi，直接调 renderReply —— 覆盖后端各种「奇怪但真实存在」的响应形状。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from 'koishi'
import { joinURL, renderReply, sniffImageMime, type BackendCall } from '../../src/backend'
import { MESSAGES } from '../../src/config'
import { TINY_PNG_BASE64 } from '../helpers'

const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
} as unknown as Context

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const GIF = Buffer.from('GIF89a', 'latin1')
const PNG = Buffer.from(TINY_PNG_BASE64, 'base64')

function textOf(elements: { type: string, attrs: Record<string, unknown> }[]): string {
  return elements.map(e => String(e.attrs.content ?? '')).join('')
}

describe('sniffImageMime', () => {
  it('按魔术字节识别格式，而不是硬编码 png', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(GIF)).toBe('image/gif')
  })

  it('认不出来时退回 png', () => {
    expect(sniffImageMime(Buffer.from('nonsense'))).toBe('image/png')
  })
})

describe('joinURL', () => {
  it('容忍两侧多写/少写斜杠', () => {
    expect(joinURL('http://127.0.0.1:3002', '/searchSong')).toBe('http://127.0.0.1:3002/searchSong')
    expect(joinURL('http://127.0.0.1:3002/', 'searchSong')).toBe('http://127.0.0.1:3002/searchSong')
    expect(joinURL('http://127.0.0.1:3002///', '//searchSong')).toBe('http://127.0.0.1:3002/searchSong')
  })
})

describe('renderReply', () => {
  it('把 listToBase64 渲染成文本与图片元素，并按内容判定 MIME', () => {
    const call: BackendCall = {
      ok: true,
      status: 200,
      body: [
        { type: 'string', string: '先看这个' },
        { type: 'base64', string: JPEG.toString('base64') },
      ],
    }
    const elements = renderReply(ctx, call)
    expect(elements).toHaveLength(2)
    expect(elements[0].type).toBe('text')
    expect(elements[1].type).toBe('img')
    // compress=true 时后端出 JPEG，这里必须报 jpeg
    expect(elements[1].attrs.src).toContain('data:image/jpeg;base64,')
  })

  it('PNG 的 base64 按 PNG 渲染（与 compress 无关，靠嗅探）', () => {
    const elements = renderReply(ctx, { ok: true, status: 200, body: [{ type: 'base64', string: PNG.toString('base64') }] })
    expect(elements[0].attrs.src).toContain('data:image/png;base64,')
  })

  it('{status:"failed"} 取 data 作为文案', () => {
    const elements = renderReply(ctx, { ok: true, status: 200, body: { status: 'failed', data: '错误: 没有有效的关键词' } })
    expect(textOf(elements)).toBe('错误: 没有有效的关键词')
  })

  it('{status:"success", data:[…]} 继续按列表渲染', () => {
    const call: BackendCall = { ok: true, status: 200, body: { status: 'success', data: [{ type: 'string', string: 'ok' }] } }
    expect(textOf(renderReply(ctx, call))).toBe('ok')
  })

  it('非 2xx 但带域内文案时优先用文案', () => {
    // 后端未启用数据库的占位路由就是 404 + {"status":"fail","data":"错误: …"}
    const call: BackendCall = { ok: true, status: 404, body: { status: 'fail', data: '错误: 服务器未启用数据库' } }
    expect(textOf(renderReply(ctx, call))).toBe('错误: 服务器未启用数据库')
  })

  it('非 2xx 且响应体是纯文本时不假设它是 JSON', () => {
    // 兜底 404 返回的就是纯文本 '404 Not Found'
    const elements = renderReply(ctx, { ok: true, status: 404, body: '404 Not Found' })
    expect(textOf(elements)).toContain('后端返回 HTTP 404')
    expect(textOf(elements)).toContain('404 Not Found')
  })

  it('400 参数校验失败时把字段级原因带出来', () => {
    const call: BackendCall = {
      ok: true,
      status: 400,
      body: {
        status: 'failed',
        data: '参数错误',
        error: [{ type: 'field', value: 4, msg: 'Invalid value', path: 'difficultyId', location: 'body' }],
      },
    }
    const text = textOf(renderReply(ctx, call))
    expect(text).toContain('参数错误')
    expect(text).toContain('difficultyId')
  })

  it('传输层失败时给出可操作的提示（含原因）', () => {
    const text = textOf(renderReply(ctx, { ok: false, failure: 'connect ECONNREFUSED' }))
    expect(text).toContain(MESSAGES.backendUnavailable)
    expect(text).toContain('ECONNREFUSED')
  })

  it('空数组与无法解析的形状都有兜底文案，不会返回空回复', () => {
    expect(textOf(renderReply(ctx, { ok: true, status: 200, body: [] }))).toBe(MESSAGES.noChartData)
    expect(textOf(renderReply(ctx, { ok: true, status: 200, body: { weird: true } }))).toBe('后端返回了无法解析的内容')
  })

  it('数组里混进异常元素时跳过它而不是整条回复报废', () => {
    const call: BackendCall = {
      ok: true,
      status: 200,
      body: [{ type: 'unknown', string: 'x' }, { type: 'string', string: '保留我' }, null, 42],
    }
    const elements = renderReply(ctx, call)
    expect(elements).toHaveLength(1)
    expect(textOf(elements)).toBe('保留我')
  })
})
