/** 后端状态：排查「为什么没回复」用的 */
import { h } from 'koishi'
import type { Context } from 'koishi'
import { LEGACY_PLUGIN_VERSION, MESSAGES, REQUIRED_BACKEND_VERSION } from '../config'
import { SERVER_LIST, SERVER_DISPLAY, parseServer } from '../server'
import type { Config } from '../index'
import { callBackend, joinURL } from '../backend'

/** /health 的 data.regions[s] —— 注意字段名是 version，不是 dataVersion */
interface RegionInfo {
  version?: string
  resourceVersion?: string
}

interface HealthData {
  ok?: boolean
  region?: string
  defaultServer?: string
  servers?: string[]
  regions?: Record<string, RegionInfo>
  playerGateway?: boolean
  upTimeS?: number
}

function formatUptime(seconds: number): string {
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts: string[] = []
  if (days) parts.push(`${days} 天`)
  if (hours) parts.push(`${hours} 小时`)
  parts.push(`${minutes} 分钟`)
  return parts.join(' ')
}

/**
 * 查后端 /health。
 * 这是唯一一个 GET 端点，也是唯一一个在出问题时还能给出有用信息的指令，
 * 所以后端不可达时这里要说清楚「连不上哪个地址」。
 */
export async function backendStatus(ctx: Context, config: Config): Promise<h[]> {
  const call = await callBackend(ctx, config, '/health', {}, 'get')

  if (!call.ok) {
    return [h.text(`${MESSAGES.backendUnavailable}\n地址: ${joinURL(config.backendURL, '/health')}\n原因: ${call.failure}`)]
  }
  if (call.status && call.status >= 400) {
    return [h.text(`后端返回 HTTP ${call.status}（${call.url}）`)]
  }

  // /health 的形状是 {status:'success', data:{...}}；老版本可能直接给 data，两种都兜住
  const body = (call.body ?? {}) as HealthData & { data?: HealthData }
  const payload: HealthData = body.data ?? body

  const lines = ['Tomori 后端正常']
  lines.push(`地址: ${config.backendURL}`)

  const defaultServer = parseServer(payload.defaultServer ?? payload.region)
  if (defaultServer) lines.push(`缺省区域: ${defaultServer}（${SERVER_DISPLAY[defaultServer]}）`)

  // 逐服列 master 版本；后端没给 regions 时退回旧的单值字段
  const regions = payload.regions
  if (regions && typeof regions === 'object') {
    for (const server of SERVER_LIST) {
      const info = regions[server]
      if (!info) continue
      const parts = [info.version, info.resourceVersion].filter(Boolean).join(' / ')
      lines.push(`${SERVER_DISPLAY[server]}: ${parts || '未知'}`)
    }
  } else if (typeof (payload as { dataVersion?: string }).dataVersion === 'string') {
    lines.push(`master 版本: ${(payload as { dataVersion?: string }).dataVersion}`)
  }

  lines.push(`玩家数据源: ${payload.playerGateway ? '自建网关（可查任意玩家）' : '站点公开接口（仅已验证公开的账号）'}`)
  if (typeof payload.upTimeS === 'number') lines.push(`已运行: ${formatUptime(payload.upTimeS)}`)

  // 契约自检：四区域列表是 1.1.0 起的标志。旧后端不认识本插件的请求体字段，
  // 会把服务器参数**静默忽略**（查出来的服是错的），所以这里要明说而不是让人猜。
  if (!Array.isArray(payload.servers) || !payload.servers.length) {
    lines.push(`注意: 这个后端不是本插件对应的契约版本（需要 Tomori 后端 ${REQUIRED_BACKEND_VERSION} 及以上）`)
    lines.push(`请升级后端，或回退插件: npm i koishi-plugin-tomori-ournotes@${LEGACY_PLUGIN_VERSION}`)
  }

  return [h.text(lines.join('\n'))]
}
