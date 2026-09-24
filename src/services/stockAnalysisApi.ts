/**
 * 股票分析模块 API（服务端 /api/stockanalysis）
 * - GET  无参：概览（可用日期列表 + 最新一日报告）
 * - GET  ?date=：指定日期报告
 * - PUT  ：同步跟踪列表（symbols）
 * - POST ：手动触发生成（抓取东财公开数据，约 10-30 秒）
 */
import type { StockReportDay } from '../types'

export interface StockAnalysisOverview {
  symbols: string[]
  dates: string[]
  latest: StockReportDay | null
}

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

export async function fetchStockAnalysisOverview(): Promise<StockAnalysisOverview> {
  return parseOrThrow<StockAnalysisOverview>(await fetch('/api/stockanalysis'))
}

export async function fetchStockReportDay(date: string): Promise<StockReportDay> {
  return parseOrThrow<StockReportDay>(
    await fetch(`/api/stockanalysis?date=${encodeURIComponent(date)}`),
  )
}

export async function syncStockAnalysisSymbols(symbols: string[]): Promise<void> {
  await parseOrThrow<{ ok: boolean }>(
    await fetch('/api/stockanalysis', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbols),
    }),
  )
}

export async function runStockAnalysis(symbols?: string[]): Promise<StockReportDay> {
  return parseOrThrow<StockReportDay>(
    await fetch('/api/stockanalysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbols ? { symbols } : {}),
    }),
  )
}
