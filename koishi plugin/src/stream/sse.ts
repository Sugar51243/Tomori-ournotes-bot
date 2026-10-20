/**
 * Server-Sent Events 的增量解析。
 *
 * 后端 `/announcementStream/{server}` 是标准 SSE：`event:` / `data:` 行 + 空行分段，
 * 另有两样不是事件的东西：
 * - 注释行（`:` 开头），后端拿它做心跳：`: ping`
 * - `ready` 握手事件，只在连接建立时发一次，不携带公告内容
 *
 * 这个解析器**必须能处理跨 chunk 的半行** —— 网络分片跟行边界没有任何关系，
 * 一次 chunk 可能停在 JSON 中间，也可能一次带来好几个事件。
 */
import type { Server } from '../server'
import { SERVER_DISPLAY, parseServer } from '../server'
import type { BackendItem } from '../backend'

export interface SseEvent {
  /** 事件名；SSE 里缺省是 `message` */
  event: string
  /** 多行 data 按规范用 \n 拼接 */
  data: string
}

export interface SseParser {
  /** 喂一段文本，返回这段里解析完整的事件（不含注释行） */
  push(chunk: string): SseEvent[]
  /** 流结束时把残留缓冲也吐出来（有些服务端最后不加空行） */
  flush(): SseEvent[]
}

interface Pending {
  event?: string
  data: string[]
}

/** 一行里 `field` 与 `value` 的分隔：冒号后若有一个空格要吃掉 */
function parseField(line: string): [string, string] {
  const index = line.indexOf(':')
  if (index < 0) return [line, '']
  const field = line.slice(0, index)
  let value = line.slice(index + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  return [field, value]
}

export function createSseParser(): SseParser {
  let buffer = ''
  let pending: Pending = { data: [] }

  const takeEvent = (): SseEvent | undefined => {
    if (pending.data.length === 0 && pending.event === undefined) return undefined
    const event: SseEvent = { event: pending.event ?? 'message', data: pending.data.join('\n') }
    pending = { data: [] }
    return event
  }

  const consumeLine = (rawLine: string): SseEvent | undefined => {
    // 兼容 CRLF：按 \n 切完还要去掉行尾的 \r
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // 注释行（心跳 `: ping`）直接丢
    if (line.startsWith(':')) return undefined
    if (line === '') return takeEvent()
    const [field, value] = parseField(line)
    if (field === 'event') pending.event = value
    else if (field === 'data') pending.data.push(value)
    // id / retry 字段本项目用不到，忽略
    return undefined
  }

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk
      const events: SseEvent[] = []
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const event = consumeLine(line)
        if (event) events.push(event)
      }
      return events
    },
    flush(): SseEvent[] {
      const events: SseEvent[] = []
      if (buffer) {
        const event = consumeLine(buffer)
        buffer = ''
        if (event) events.push(event)
      }
      const tail = takeEvent()
      if (tail) events.push(tail)
      return events
    },
  }
}

/**
 * 推送载荷。后端 `announcementStream` 的事件形状（已对真实抓包 `sse-tw.log` 核实）：
 * `{server, kind:'added'|'updated', id, title, category, updatedAt, images:[{type,string}]}`
 */
export interface AnnouncementEvent {
  server: Server
  kind: 'added' | 'updated'
  id: string
  title: string
  category?: string
  updatedAt?: string
  images: BackendItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析一条 announcement 事件的 data；形状不对返回 undefined（跳过而不是让整条流炸掉） */
export function decodeAnnouncementEvent(raw: string): AnnouncementEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const server = parseServer(parsed.server)
  const id = String(parsed.id ?? '').trim()
  const title = typeof parsed.title === 'string' ? parsed.title : ''
  const kind = parsed.kind === 'updated' ? 'updated' : 'added'

  // 服务器认不出来时这条推不了（不知道推给谁）
  if (!server) return undefined

  const images: BackendItem[] = []
  if (Array.isArray(parsed.images)) {
    for (const item of parsed.images) {
      if (!isRecord(item)) continue
      if (typeof item.string !== 'string') continue
      if (item.type === 'base64') images.push({ type: 'base64', string: item.string })
      else if (item.type === 'string') images.push({ type: 'string', string: item.string })
    }
  }

  // 既没标题也没可用内容时无东西可推，跳过（防上游异常载荷）
  if (!title && !images.length) return undefined

  return {
    server,
    kind,
    id,
    title,
    category: typeof parsed.category === 'string' ? parsed.category : undefined,
    updatedAt: parsed.updatedAt === undefined ? undefined : String(parsed.updatedAt),
    images,
  }
}

/**
 * 推送消息的抬头。
 *
 * 公告详情图自己带标题与服名，但**看不出这是一条推送、更看不出是新增还是修改**，
 * 所以推送必须自己加一句。
 */
export function announcementHeader(event: AnnouncementEvent): string {
  const action = event.kind === 'updated' ? '公告更新' : '公告新增'
  const title = event.title || `#${event.id}`
  return `【${SERVER_DISPLAY[event.server]}】${action}：${title}`
}
