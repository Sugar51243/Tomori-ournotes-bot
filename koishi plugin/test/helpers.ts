/**
 * 测试夹具。
 *
 * 测试策略：**用真实 Koishi 运行时 + 假的后端**。
 * - 指令注册、参数解析、`before-send` 钩子都走 Koishi 自己的实现，不重写
 * - `ctx.http` 换成记录型假实现，这样既能断言「插件发了什么请求体」，
 *   又能完全控制「后端回什么」，不需要真的起一个后端
 * - 模拟输入/输出用官方的 @koishijs/plugin-mock（`app.mock.client(...)`）
 *
 * 另有一组 integration 测试直接打真实 Tomori 后端，见 test/integration/。
 */
import { Context } from 'koishi'
import MockBot from '@koishijs/plugin-mock'
// 用命名导出而不是默认导出：@koishijs/plugin-http 的 ESM 产物是
// `export * from '@cordisjs/plugin-http'`，而 `export *` **不转发 default**，
// 于是默认导入在 ESM 下是 undefined（CJS 下才有）。
import { HTTP } from '@koishijs/plugin-http'
import type { Config } from '../src/index'
import { apply, name } from '../src/index'
import { DEFAULT_BACKEND_URL } from '../src/config'

export interface HttpCallOptions {
  method?: string
  data?: unknown
  timeout?: number
  validateStatus?: (status: number) => boolean
  responseType?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface RecordedRequest {
  method: 'post' | 'get'
  url: string
  data?: unknown
  timeout?: number
  validateStatus?: (status: number) => boolean
  responseType?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface FakeResponse {
  data: unknown
  status: number
  statusText: string
  url: string
  headers: Headers
}

export function ok(body: unknown): FakeResponse {
  return { data: body, status: 200, statusText: 'OK', url: '', headers: new Headers() }
}

export function httpError(status: number, body: unknown, statusText = ''): FakeResponse {
  return { data: body, status, statusText: statusText || String(status), url: '', headers: new Headers() }
}

export type Responder = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>

export interface TestApp {
  app: Context
  /** 按顺序记录插件发出的每一个请求 */
  requests: RecordedRequest[]
  /** 只取某次请求的请求体，方便断言 */
  bodyOf: (index: number) => unknown
  /** 按 endpoint 后缀找第一个请求的请求体 */
  bodyFor: (endpointSuffix: string) => unknown
  dispose: () => Promise<void>
}

export const TEST_BACKEND = 'http://backend.test'

/** 构造一个只带假 http 的 Koishi 应用，并装上被测插件 */
export async function createTestApp(
  responder: Responder,
  config: Partial<Config> = {},
): Promise<TestApp> {
  const app = new Context()
  const requests: RecordedRequest[] = []

  const record = (request: RecordedRequest): Promise<FakeResponse> | FakeResponse => {
    requests.push(request)
    return responder(request)
  }

  /**
   * 假 http 服务复刻的是 Koishi HTTP 服务的**可调用形态**：
   * `ctx.http(url, { method, data, timeout, validateStatus })` -> 完整响应。
   *
   * 插件刻意不用 `ctx.http.post(...)` 便捷方法 —— 那个只返回 `response.data`，
   * 会丢掉状态码（见 src/backend.ts 里的说明），所以假实现也不需要 post/get。
   */
  const httpService = (url: string, options: HttpCallOptions = {}) => {
    const method = (options.method ?? 'GET').toLowerCase() as 'post' | 'get'
    return Promise.resolve(record({
      method,
      url,
      data: options.data,
      timeout: options.timeout,
      validateStatus: options.validateStatus,
      responseType: options.responseType,
      signal: options.signal,
      headers: options.headers,
    }))
  }
  app.set('http', httpService as never)

  // mock 平台适配器，提供 app.mock.client(...) 作为模拟输入/输出
  app.plugin(MockBot)
  const fork = app.plugin({ name: name as never, apply: apply as never }, {
    backendURL: TEST_BACKEND,
    backupURLs: [],
    compress: true,
    reply: false,
    at: false,
    stubCommands: true,
    defaultServers: ['tw', 'jp', 'kr', 'en'],
    defaultServer: 'tw',
    // 推流会起后台长连接，而 TestApp.dispose 故意不调 app.stop()，
    // 开着的话会把 vitest 挂住。推流本身由 test/unit/manager.test.ts 直接构造 manager 覆盖。
    announcementStream: false,
    subscriptionFile: '',
    requestTimeout: 1000,
    ...config,
  } as never)

  await app.start()

  return {
    app,
    requests,
    bodyOf: (index: number) => requests[index]?.data,
    // 返回**最近一次**匹配的请求体：同一个 app 会在多个用例间复用，
    // 取第一个会拿到上一个用例的陈旧请求
    bodyFor: (endpointSuffix: string) => {
      for (let i = requests.length - 1; i >= 0; i--) {
        if (requests[i].url.endsWith(endpointSuffix)) return requests[i].data
      }
      return undefined
    },
    dispose: () => disposeApp(fork),
  }
}

/**
 * 收尾。
 *
 * 这里**不调用 `app.stop()`**：cordis 拆服务（`ctx.bots`）与 mock 适配器
 * 收尾 MockBot 的顺序是先拆服务后收尾，导致 `Bot.dispose()` 里的
 * `this.ctx.bots.findIndex(...)` 必然抛 `Cannot read properties of undefined`。
 * 那是第三方收尾顺序的问题，catch 不住（它在 cordis 的事件回调里抛出并被打印）。
 *
 * 但**插件自己的 fork 要拆** —— 公告推流会在 `ctx.on('dispose')` 里停掉连接与
 * 定时器，不拆的话开着的手柄会把 vitest 拖住。拆一个 fork 不碰服务注册表，
 * 是安全的。
 */
async function disposeApp(fork: { dispose(): void } | undefined): Promise<void> {
  try {
    fork?.dispose()
  } catch {
    // 收尾失败不该让用例失败
  }
}

/**
 * 用真实 HTTP 打真实后端的应用（集成测试用）。
 * 与 createTestApp 的区别：不注入假 http，而是装上 Koishi 官方的 http 服务。
 */
export async function createLiveApp(
  backendURL: string,
  config: Partial<Config> = {},
): Promise<TestApp> {
  const app = new Context()
  app.plugin(MockBot)
  app.plugin(HTTP)
  const fork = app.plugin({ name: name as never, apply: apply as never }, {
    backendURL,
    backupURLs: [],
    compress: true,
    reply: false,
    at: false,
    stubCommands: true,
    defaultServers: ['tw', 'jp', 'kr', 'en'],
    defaultServer: 'tw',
    // 集成测试不打推流（长连接会拖住收尾），握手单独用裸 fetch 验
    announcementStream: false,
    subscriptionFile: '',
    requestTimeout: 120_000,
    ...config,
  } as never)
  await app.start()
  return {
    app,
    requests: [],
    bodyOf: () => undefined,
    bodyFor: () => undefined,
    dispose: () => disposeApp(fork),
  }
}

/** 后端是否在线（集成测试用它决定 skip 还是跑） */
export async function isBackendUp(backendURL: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${backendURL.replace(/\/+$/, '')}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

/**
 * 在线的是不是**这一版契约**的后端。
 *
 * 只认一个特征：`/health` 的 data 里有没有四个区域（旧版只有单个 region、单值 dataVersion）。
 * 有这一道，才能把「端口上蹲着另一个旧实例」和「插件改坏了」区分开 ——
 * 前者应该跳过并说清楚，后者应该红。
 */
export async function isBackendCompatible(backendURL: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${backendURL.replace(/\/+$/, '')}/health`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return false
    const body = await response.json() as { data?: { servers?: unknown } }
    const servers = body?.data?.servers
    return Array.isArray(servers) && servers.includes('tw')
  } catch {
    return false
  }
}

/** 一个 1x1 的透明 PNG，用作后端出图的桩数据（避免把巨大的 base64 塞进断言） */
export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 后端 listToBase64 协议的出图响应 */
export function imageReply(base64 = TINY_PNG_BASE64) {
  return [{ type: 'base64', string: base64 }]
}

/** 后端 listToBase64 协议的出文案响应（域内错误就是长这样） */
export function textReply(text: string) {
  return [{ type: 'string', string: text }]
}

/** 后端 JSON 类端点的成功响应 */
export function jsonSuccess(data: unknown) {
  return { status: 'success', data }
}

/** 后端 JSON 类端点的失败响应 */
export function jsonFailed(message: string) {
  return { status: 'failed', data: message }
}

export { DEFAULT_BACKEND_URL }
