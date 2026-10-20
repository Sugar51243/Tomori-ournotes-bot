/** 谱面：查谱面（出图） / 谱面数据（出文字摘要） */
import { h } from 'koishi'
import type { Context } from 'koishi'
import type { Server } from '../server'
import type { Config } from '../index'
import { callBackend, extractData, queryEntity, renderReply } from '../backend'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 查谱面：出 Our Notes 风格的 24 轨谱面预览图。
 *
 * 歌名与数字 ID 都直接交给 `/songChart` —— 后端自己会做模糊搜索：
 * 唯一命中出该曲谱面图，多命中出歌曲列表图（提示用 ID 精确查谱）。
 * 早先插件要先 `/fuzzySearch` 拿 ID 再查谱，现在省掉这一跳。
 *
 * 难度/镜像/流速由调用方解析好后一起透传；流速不写就不发这个字段，
 * 由后端用它自己的默认值（7.5）。
 */
export async function songChart(
  ctx: Context,
  config: Config,
  query: string,
  difficultyId: number,
  mirror: boolean,
  noteSpeed: number | undefined,
  servers: Server[],
): Promise<h[]> {
  return queryEntity(ctx, config, '/songChart', servers, query, {
    difficultyId,
    mirror,
    noteSpeed,
  })
}

/** counts 的键来自上游 nnnotes 格式，给已知的键配中文标签，未知的键原样追加 */
const COUNT_LABELS: Array<[string, string]> = [
  ['Normal', '普通'],
  ['Flick', 'Flick'],
  ['SlideBegin', '滑条起'],
  ['SlideConnection', '滑条连'],
  ['SlideEnd', '滑条尾'],
  ['SlideBeginFlick', '滑条起 Flick'],
  ['SlideEndFlick', '滑条尾 Flick'],
  ['SlideConnectionTrace', '滑条轨迹'],
  ['GuideBegin', '引导起'],
  ['GuideEnd', '引导尾'],
  ['Combo', 'Combo'],
  ['ComboSkip', 'Combo 跳过'],
  ['Hidden', '隐藏'],
]

function formatDuration(durationMs: number): string {
  const total = Math.round(durationMs / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * 把 BPM 压成一段可读文本。
 *
 * 后端有两个来源，形状不同，都要认：
 * - `meta.bpm`  —— 段数组 `[{bpm, timeStartMs, timeEndMs}]`
 * - `simple.bpm` —— `{segments:[…], value}`（value 是时长加权中位数）
 */
function formatBpm(...candidates: unknown[]): string | undefined {
  const segments: number[] = []
  for (const candidate of candidates) {
    const list = Array.isArray(candidate)
      ? candidate
      : isRecord(candidate) && Array.isArray(candidate.segments) ? candidate.segments : []
    for (const segment of list) {
      if (!isRecord(segment) || typeof segment.bpm !== 'number') continue
      if (!segments.includes(segment.bpm)) segments.push(segment.bpm)
    }
    if (segments.length) break
  }
  if (!segments.length) {
    for (const candidate of candidates) {
      if (isRecord(candidate) && typeof candidate.value === 'number') segments.push(candidate.value)
    }
  }
  if (!segments.length) return undefined
  return segments.map((value) => {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }).join(' / ')
}

function formatCounts(counts: unknown): string | undefined {
  if (!isRecord(counts)) return undefined
  const parts: string[] = []
  const seen = new Set<string>()
  const push = (key: string, label: string): void => {
    const value = counts[key]
    if (typeof value !== 'number' || value === 0) return
    seen.add(key)
    parts.push(`${label} ${value}`)
  }
  for (const entry of COUNT_LABELS) push(entry[0], entry[1])
  // 上游加了新的音符类型时兜底，避免静默丢信息
  for (const key of Object.keys(counts)) {
    if (!seen.has(key) && key !== '') push(key, key)
  }
  return parts.length ? parts.join(' / ') : undefined
}

/**
 * 谱面数据：后端返回纯 JSON（含全部音符），直接贴群里没法看，
 * 这里转成一段摘要文字。需要原始 JSON 的话直接调后端 /songChartData。
 *
 * 歌名与 ID 都收：文本只在唯一命中时出结果，多命中后端会回一句
 * 「匹配到多首歌曲，请用 songId 精确指定」，原样透出即可。
 */
export async function songChartSummary(
  ctx: Context,
  config: Config,
  query: string,
  difficultyId: number,
  mirror: boolean,
  servers: Server[],
): Promise<h[]> {
  const call = await callBackend(ctx, config, '/songChartData', {
    displayedServerList: servers,
    id: query,
    difficultyId,
    mirror,
    format: 'simple',
  })
  if (!call.ok) return renderReply(ctx, call)

  const data = extractData(call.body)
  if (!isRecord(data) || !isRecord(data.meta)) {
    // 失败时 body 是 {status:'failed', data:'错误: ...'}，交给通用渲染取文案
    return renderReply(ctx, call)
  }

  const meta = data.meta
  const simple = isRecord(data.simple) ? data.simple : undefined
  const lines: string[] = []
  const title = typeof meta.title === 'string' ? meta.title : '未知曲目'
  lines.push(`${title}  [${String(meta.musicId ?? query)}]`)
  lines.push(`难度: ${String(meta.difficulty ?? difficultyId)}${meta.level !== undefined ? ` (Lv.${String(meta.level)})` : ''}${mirror ? ' · 镜像' : ''}`)
  if (typeof meta.durationMs === 'number') lines.push(`时长: ${formatDuration(meta.durationMs)}`)
  const bpm = formatBpm(meta.bpm, simple?.bpm)
  if (bpm) lines.push(`BPM: ${bpm}`)
  if (typeof meta.laneCount === 'number') lines.push(`轨道: ${meta.laneCount}`)
  const counts = formatCounts(meta.counts ?? simple?.counts)
  if (counts) lines.push(`音符: ${counts}`)
  if (typeof meta.slideCount === 'number') lines.push(`滑条: ${meta.slideCount}`)
  if (typeof meta.feverCount === 'number') lines.push(`Fever: ${meta.feverCount}`)

  return [h.text(lines.join('\n'))]
}
