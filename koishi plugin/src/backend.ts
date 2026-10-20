/**
 * 与 Tomori 后端通信的唯一出口。
 *
 * 对应参考项目 bestdori-tsugu-extra 的 `call_tsugu` + `handle_tsugu_result`，
 * 但Tomori 的协议更简单，且有几个必须处理的坑：
 *
 * 1. **域内错误可能带非 2xx 状态码**。后端约定「域内错误以 HTTP 200 返回」，
 *    但未启用数据库的占位路由实际用的是 404 + `{status:'fail', data:'错误: ...'}`，
 *    参数校验失败用 400，内部错误用 500。所以这里统一传 `validateStatus: () => true`
 *    让所有状态码都正常 resolve（Koishi 的 HTTP 服务默认 `status < 400` 才不抛错），
 *    再自己判断状态码 —— 比从抛出的异常里抠响应体干净得多。
 *
 * 2. **响应体类型由 Content-Type 决定**。Koishi 的默认解码器是
 *    application/json → 对象、text/* → 字符串、其它 → ArrayBuffer。
 *    后端 `res.send({...})` 走 JSON，`res.send('404 Not Found')` 走 text/html（字符串）。
 *
 * 3. **不能假设错误体是 JSON**。兜底 404 返回的是纯文本 `404 Not Found`，
 *    对它 `.data` 取字段只会得到 undefined。
 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { MESSAGES } from './config'
import type { Server } from './server'
import type { Config } from './index'

/** 后端 listToBase64 协议的元素 */
export interface BackendTextItem { type: 'string', string: string }
export interface BackendImageItem { type: 'base64', string: string }
export type BackendItem = BackendTextItem | BackendImageItem

/** 一次后端调用：要么拿到 HTTP 响应（ok=true，无论状态码），要么传输层失败（ok=false） */
export interface BackendCall {
  ok: boolean
  /** HTTP 状态码，ok=false 时不存在 */
  status?: number
  /** 响应体：JSON 对象/数组，或文本字符串 */
  body?: unknown
  /** 实际请求的地址（排查用） */
  url?: string
  /** ok=false 时的失败原因 */
  failure?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拼接 base 与 endpoint，容忍两侧各自多写或少写斜杠 */
export function joinURL(base: string, endpoint: string): string {
  return `${base.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

/** 把传输层异常转成一句人能读的话 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return cause.message
    return error.message || error.name
  }
  return String(error)
}

/**
 * 向后端发一次请求（默认 POST；只有 /health 用 GET）。
 *
 * 按 backendURL → backupURLs 的顺序重试，但**只在传输层失败时重试**：
 * 一旦拿到了 HTTP 响应（哪怕是 500）就立刻返回，
 * 因为那是后端的业务答复，换地址重试没有意义。
 */
export async function callBackend(
  ctx: Context,
  config: Config,
  endpoint: string,
  body: Record<string, unknown> = {},
  method: 'post' | 'get' = 'post',
): Promise<BackendCall> {
  const targets = [config.backendURL, ...config.backupURLs].filter(Boolean)
  const verb = method === 'get' ? 'GET' : 'POST'
  let lastFailure = ''

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]
    const url = joinURL(target, endpoint)
    const startedAt = Date.now()
    try {
      /**
       * 这里**不用 `ctx.http.post(...)`**：那个便捷方法内部是
       * `return response.data`（见 @cordisjs/plugin-http 里
       * `["patch","post","put"]` 的定义），只给出响应体，丢了状态码。
       *
       * 而后端的状态码是有信息的：域内错误既可能以 200 返回
       * （如 `['错误: …']`），也可能以 404 返回
       * （占位路由 `{status:'fail', data:'错误: 服务器未启用数据库'}`）。
       * 把服务当函数直接调用拿到完整响应，才能区分这两种情况。
       *
       * `validateStatus: () => true` 同样是必需的：Koishi 默认只在
       * status < 400 时不抛错，不接管的话 4xx/5xx 的响应体就取不到了。
       */
      const requestConfig: Record<string, unknown> = {
        method: method === 'get' ? 'GET' : 'POST',
        timeout: config.requestTimeout,
        validateStatus: () => true,
      }
      // GET 不能带 body，否则 fetch 直接抛
      // 「Request with GET/HEAD method cannot have body」
      if (method !== 'get') requestConfig.data = body

      const response = await ctx.http(url, requestConfig) as unknown as { status: number, data: unknown }

      // 每次请求记一行：排查「用户说没反应」时，这条日志能直接指出打的是哪个端点、后端怎么答的
      logger(ctx, 'info', `${verb} ${endpoint} → ${response.status}（${Date.now() - startedAt}ms）`)
      return { ok: true, status: response.status, body: response.data, url }
    } catch (error) {
      lastFailure = describeError(error)
      logger(ctx, 'warn', `${verb} ${endpoint} 连接失败（${target}）：${lastFailure}`)
      if (index + 1 < targets.length) {
        logger(ctx, 'info', `${endpoint} 改用备用地址 ${targets[index + 1]}`)
      }
    }
  }

  return { ok: false, failure: lastFailure || '无可用后端地址' }
}

/**
 * 从可能的各种形状里抠出一句可读的错误文案。
 *
 * 后端的错误形状有四种：
 * - `{status:'fail'|'failed', data:'错误: …'}`     域内错误（多数）
 * - `{status:'failed', data:'参数错误', error:[…]}` 参数校验失败（400），字段级原因在 error 里
 * - `{status:'failed', data:'需要提供查询输入: …'}` 一个查询输入都没给（422），没有 error 数组
 * - `'404 Not Found'`                              兜底路由的纯文本，**不是** JSON
 */
function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const text = body.trim()
    return text || undefined
  }
  if (isRecord(body)) {
    const data = typeof body.data === 'string' ? body.data.trim() : ''
    const reasons = collectFieldReasons(body.error)
    // 参数校验失败时 data 只是「参数错误」四个字，真正的信息在 error 里，两者都要给
    if (data && reasons) return `${data}（${reasons}）`
    if (data) return data
    if (reasons) return `参数错误（${reasons}）`
  }
  return undefined
}

/** 把 express-validator 的 error 数组压成 `字段: 原因` 列表 */
function collectFieldReasons(error: unknown): string {
  if (!Array.isArray(error)) return ''
  return error
    .map((item) => {
      if (!isRecord(item)) return String(item)
      const path = Array.isArray(item.path) ? item.path.join('.') : item.path
      return [path, item.msg].filter(Boolean).join(': ')
    })
    .filter(Boolean)
    .join('; ')
}

/**
 * 图片的 MIME 用魔术字节嗅探，而不是听调用方或硬编码。
 *
 * 参考项目一律写死 `image/png`，但 Tomori 在 compress=true 时出的是 JPEG，
 * `/getStampImage` 出的是 webp，`/getCardIllustration` 出的是 PNG ——
 * 写死会让适配器拿到错误的类型。
 */
export function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('latin1')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  return 'image/png'
}

/**
 * 把后端的 listToBase64 数组渲染成 Koishi 消息元素。
 * 非数组元素（不该出现）会被跳过并记一条日志，而不是整条回复报废。
 *
 * 不需要 compress 参数：图片格式由魔术字节嗅探（见 sniffImageMime），
 * 传不传 compress 只影响请求体里给后端的出图选项。
 */
export function renderList(ctx: Context, list: unknown[]): h[] {
  const result: h[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const value = item.string
    if (typeof value !== 'string') continue
    if (item.type === 'string') {
      result.push(h.text(value))
    } else if (item.type === 'base64') {
      const buffer = Buffer.from(value, 'base64')
      result.push(h.image(buffer, sniffImageMime(buffer)))
    } else {
      logger(ctx, 'warn', `未知的后端元素类型: ${String(item.type)}`)
    }
  }
  return result
}

function logger(ctx: Context, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    ctx.logger('tomori')[level](message)
  } catch {
    // 测试夹具里的 ctx 可能没有 logger，忽略
  }
}

/**
 * 把一次后端调用渲染成可发送的元素。
 *
 * 覆盖的形状：
 * - `[{type,string}]`            → 文本 + 图片（MIME 靠嗅探，不依赖 compress）
 * - `{status:'success', data}`   → data 是数组则继续渲染，否则按文案处理
 * - `{status:'fail'|'failed'}`   → 取 data 作为错误文案
 * - `'文本'`                      → 直接当文案
 */
export function renderReply(ctx: Context, call: BackendCall): h[] {
  if (!call.ok) {
    const detail = call.failure ? `（${call.failure}）` : ''
    return [h.text(`${MESSAGES.backendUnavailable}${detail}`)]
  }

  const { status = 0, body } = call

  // 非 2xx：后端通常仍会带一句域内文案（404 占位路由就是），优先用它。
  // 但纯文本的 `404 Not Found` 是兜底路由的敷衍答复，信息量太低 ——
  // 这种情况下把状态码一起报出来，用户才知道是「路由不存在」而不是「后端说的」。
  if (status >= 400) {
    logger(ctx, 'warn', `后端返回 HTTP ${status}（${call.url ?? '未知地址'}）`)
    if (typeof body === 'string') {
      return [h.text(`后端返回 HTTP ${status}: ${body.trim()}`)]
    }
    const message = extractMessage(body)
    if (message) return [h.text(message)]
    return [h.text(`后端返回 HTTP ${status}`)]
  }

  if (Array.isArray(body)) {
    return renderListOrFallback(ctx, body)
  }

  if (isRecord(body)) {
    if (body.status === 'success' && Array.isArray(body.data)) {
      return renderListOrFallback(ctx, body.data)
    }
    const message = extractMessage(body)
    if (message) return [h.text(message)]
    return [h.text(MESSAGES.unparsableBody)]
  }

  if (typeof body === 'string') {
    const text = body.trim()
    return [h.text(text || MESSAGES.noChartData)]
  }

  return [h.text(MESSAGES.noChartData)]
}

function renderListOrFallback(ctx: Context, list: unknown[]): h[] {
  const elements = renderList(ctx, list)
  return elements.length ? elements : [h.text(MESSAGES.noChartData)]
}

/** 一次性完成「调用 + 渲染」，绝大多数指令只需要这个 */
export async function query(
  ctx: Context,
  config: Config,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<h[]> {
  const call = await callBackend(ctx, config, endpoint, body)
  return renderReply(ctx, call)
}

/**
 * 统一实体查询：按后端契约组装请求体并调用。
 *
 * 后端把「查什么」收成了一个 `id` 字段 —— 数字或纯数字串按 ID 直查，
 * 其余文本走模糊搜索（唯一命中出详情图、多命中出列表图）。所以插件
 * 既不必先调 `/fuzzySearch`，也不用记各端点专属的 ID 字段名。
 *
 * 服务器统一走 `displayedServerList`：单服端点取首个（不回退），
 * 多服端点用全部；用户没写时由调用方决定传什么。
 *
 * `compress` 是图片端点通用的（个别端点不读它，多传一个字段后端会忽略）。
 */
export async function queryEntity(
  ctx: Context,
  config: Config,
  endpoint: string,
  servers: readonly Server[],
  id: string | number | undefined,
  extra?: Record<string, unknown>,
): Promise<h[]> {
  const body: Record<string, unknown> = {
    displayedServerList: [...servers],
    compress: config.compress,
  }
  if (id !== undefined && id !== '') body.id = id
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (extra[key] !== undefined) body[key] = extra[key]
    }
  }
  return query(ctx, config, endpoint, body)
}

/**
 * 「先查一次拿 ID、再查第二次」的指令用它表示中间结果：
 * 失败时直接带上已经渲染好的回复，避免调用方把「后端挂了」误报成「没找到」。
 */
export type Resolved<T> = { ok: true, value: T } | { ok: false, reply: h[] }

/** 取出 `{status:'success', data}` 里的 data；形状不对返回 undefined */
export function extractData(body: unknown): unknown {
  if (!isRecord(body)) return undefined
  if (body.status !== 'success') return undefined
  return body.data
}
