/**
 * 首版涨停 API（服务端 /api/zt）
 * - GET /api/zt/list      全市场涨停股池（含首板/连板），30s 服务端缓存
 * - GET /api/zt/detail    单只涨停股详情（资金流 / 龙虎榜 / 两融 / 大宗）
 * - GET /api/zt/analysis  涨停分析面板数据（行业/高度/排行/涨停次数），60s 缓存
 */
import type {
  ZtListResponse,
  ZtDetailResponse,
  ZtAnalysisResponse,
} from '../types'

async function parseOrThrow<T>(resp: Response): Promise<T> {
  const text = await resp.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`响应非 JSON：${text.slice(0, 120)}`)
  }
  if (!resp.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return json as T
}

export async function fetchZtList(): Promise<ZtListResponse> {
  return parseOrThrow<ZtListResponse>(await fetch('/api/zt/list'))
}

export async function fetchZtDetail(code: string): Promise<ZtDetailResponse> {
  return parseOrThrow<ZtDetailResponse>(
    await fetch(`/api/zt/detail?code=${encodeURIComponent(code)}`),
  )
}

export async function fetchZtAnalysis(): Promise<ZtAnalysisResponse> {
  return parseOrThrow<ZtAnalysisResponse>(await fetch('/api/zt/analysis'))
}