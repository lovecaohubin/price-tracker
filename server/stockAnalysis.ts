/**
 * 股票分析模块（服务端）
 *
 * 每个交易日 15:01 自动对跟踪列表里的标的生成收盘分析报告：
 * 行情底色 / 资金流向 / 龙虎榜 / 融资融券 / 大宗交易 / 十大流通股东 / 技术指标，
 * 并按规则输出解读要点（只做刻度，不预测涨跌，附免责声明）。
 *
 * 数据源（均实测可用，2026-09-21）：
 * - 快照/估值：push2.eastmoney.com/api/qt/ulist.np/get（f2价格 f8换手 f115 PE-TTM f23 PB f20/21市值）
 * - 资金流向：push2.eastmoney.com/api/qt/stock/fflow/kline/get（主力/超大/大/中/小单）
 * - 龙虎榜：datacenter RPT_DAILYBILLBOARD_DETAILSNEW + 席位明细 RPT_BILLBOARD_DAILYDETAILSBUY/SELL
 * - 融资融券：datacenter RPTA_WEB_RZRQ_GGMX（T+1 披露）
 * - 大宗交易：datacenter RPT_DATA_BLOCKTRADE
 * - 十大流通股东：datacenter RPT_F10_EH_FREEHOLDERS（季报频率）
 * - 日 K：push2his kline（与 /api/kline 中间件同源，用于技术指标）
 */
import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  StockAnalysisStore,
  StockReport,
  StockReportDay,
  LhbSeat,
  LhbSeatType,
} from '../src/types'

// ===== 出站请求：并发限制 + 退避重试（东财对瞬时高并发会做连接重置） =====
const MAX_CONCURRENCY = 4
let activeOutbound = 0
const outboundWaiters: (() => void)[] = []

async function acquire(): Promise<void> {
  if (activeOutbound < MAX_CONCURRENCY) {
    activeOutbound++
    return
  }
  await new Promise<void>((resolve) => outboundWaiters.push(resolve))
  activeOutbound++
}

function release(): void {
  activeOutbound--
  const next = outboundWaiters.shift()
  if (next) next()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRY_DELAYS = [500, 1000, 2000]

const HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: '*/*',
}

async function fetchOutbound(apiUrl: string): Promise<string> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    await acquire()
    try {
      const resp = await fetch(apiUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      })
      const text = await resp.text()
      if (resp.ok) return text
      throw new Error(`HTTP ${resp.status}`)
    } catch (err) {
      if (attempt >= RETRY_DELAYS.length) throw err
      await sleep(RETRY_DELAYS[attempt])
    } finally {
      release()
    }
  }
  throw new Error('unreachable')
}

async function fetchJson<T = unknown>(apiUrl: string): Promise<T> {
  return JSON.parse(await fetchOutbound(apiUrl)) as T
}

// ===== 工具 =====
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const yi = (v: number | null): number | null => (v == null ? null : Number((v / 1e8).toFixed(4)))

const secidOf = (symbol: string): string => {
  const s = symbol.toLowerCase()
  return `${s.startsWith('sh') ? '1' : '0'}.${s.slice(2)}`
}

const codeOf = (symbol: string): string => symbol.toLowerCase().slice(2)

// ===== 落盘存储 =====
const STORE_FILE = path.resolve(process.cwd(), 'data', 'stockAnalysis.json')
const STORE_MAX_DAYS = 10 // 保留最近 10 个交易日

let store: StockAnalysisStore | null = null
let storeLoaded = false
let running = false // 生成任务互斥

async function loadStore(): Promise<StockAnalysisStore> {
  if (storeLoaded) return store ?? { savedAt: 0, symbols: [], days: {} }
  storeLoaded = true
  try {
    const raw = JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf-8'))
    if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
      store = {
        savedAt: Number(raw.savedAt) || 0,
        symbols: Array.isArray(raw.symbols) ? raw.symbols : [],
        days: raw.days,
      }
      console.log(`[股票分析] 本地报告已载入：${Object.keys(store.days).length} 个交易日`)
    }
  } catch {
    store = { savedAt: 0, symbols: [], days: {} }
  }
  return store!
}

async function saveStore(): Promise<void> {
  if (!store) return
  try {
    await fs.promises.mkdir(path.dirname(STORE_FILE), { recursive: true })
    // 只保留最近 N 个交易日
    const dates = Object.keys(store.days).sort()
    for (const d of dates.slice(0, Math.max(0, dates.length - STORE_MAX_DAYS))) {
      delete store.days[d]
    }
    await fs.promises.writeFile(
      STORE_FILE,
      JSON.stringify({ ...store, savedAt: Date.now() }),
      'utf-8',
    )
  } catch (err) {
    console.warn('[股票分析] 落盘失败:', err instanceof Error ? err.message : err)
  }
}

// ===== 数据抓取 =====

/** 快照/估值（ulist 批量） */
interface RawQuote {
  f2?: number; f3?: number; f5?: number; f6?: number; f8?: number; f9?: number
  f10?: number; f12?: string; f14?: string; f15?: number; f16?: number; f17?: number
  f18?: number; f20?: number; f21?: number; f23?: number; f114?: number; f115?: number
}

async function fetchSnapshot(symbol: string): Promise<{
  name: string; quote: StockReport['quote']; lastDay: string | null
}> {
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secidOf(symbol)}` +
    `&fields=f2,f3,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f114,f115`
  const json = await fetchJson<{ data?: { diff?: RawQuote[] } }>(url)
  const q = json?.data?.diff?.[0]
  if (!q || num(q.f2) == null) throw new Error('快照为空')
  const close = num(q.f2)!
  const open = num(q.f17) ?? close
  const high = num(q.f15) ?? close
  const low = num(q.f16) ?? close
  const prevClose = num(q.f18) ?? close
  return {
    name: String(q.f14 || symbol),
    quote: {
      close,
      prevClose,
      open,
      high,
      low,
      changePct: num(q.f3) != null ? num(q.f3)! / 100 : null,
      amplitude: low > 0 ? (high - low) / low : null,
      turnoverYi: num(q.f6) != null ? Number((num(q.f6)! / 1e8).toFixed(2)) : null,
      turnoverRate: num(q.f8),
      volumeRatio: num(q.f10),
      peTtm: num(q.f115),
      peStatic: num(q.f114),
      peDynamic: num(q.f9),
      pb: num(q.f23),
      marketCapTotalYi: num(q.f20) != null ? Number((num(q.f20)! / 1e8).toFixed(2)) : null,
      marketCapFloatYi: num(q.f21) != null ? Number((num(q.f21)! / 1e8).toFixed(2)) : null,
    },
    lastDay: null,
  }
}

/** 资金流向：当日 + 近 5 日主力合计 + 主力净占比
 * 字段口径（东财 fflow）：主力 = 超大单 + 大单；单位元
 * 不同数据商（腾讯/同花顺）对「主力」「超大单」的阈值不同，
 * 数据可能与三方平台存在差异，本文使用东财口径并在报告里明示。
 *
 * 注意：push2.* 是实时镜像只返回当日；历史报告必须从 push2his.* 取
 * （实测锡华 9/21：push2his 主力 -156888153 ≈ -1.57 亿，与用户模板完全吻合）
 */
async function fetchFlow(symbol: string, date: string): Promise<StockReport['flow']> {
  // 取 lmt=10 根（含历史），再按报告日期定位当日 + 此前 4 日算 5 日合计
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secidOf(symbol)}` +
    `&klt=101&lmt=10&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59`
  const json = await fetchJson<{ data?: { klines?: string[] } }>(url)
  const rows = json?.data?.klines ?? []
  if (!rows.length) throw new Error('资金流为空')
  // 行格式（已实测）：日期,主力净流入,小单,中单,大单,超大单,主力净占比,…(其余字段 0/空)
  // rows 已按日期升序。定位到报告日期对应那根，往前数 4 根（含自身共 5 根）做 5 日合计
  const splitRow = (r: string) => r.split(',')
  let idx = rows.findIndex((r) => splitRow(r)[0] === date)
  if (idx < 0) idx = rows.length - 1 // 找不到时退回到最后一根（最新可得交易日）
  const sliceEnd = idx + 1
  const sliceStart = Math.max(0, idx - 4)
  const windowRows = rows.slice(sliceStart, sliceEnd)
  const today = splitRow(windowRows[windowRows.length - 1])
  const pick = (i: number): number | null => {
    const v = Number(today[i])
    return Number.isFinite(v) ? v : null
  }
  const sumMain = windowRows.reduce((a, r) => a + (Number(splitRow(r)[1]) || 0), 0)
  const flow: StockReport['flow'] = {
    main: pick(1),
    super: pick(5),
    big: pick(4),
    mid: pick(3),
    small: pick(2),
    main5d: Number.isFinite(sumMain) ? sumMain : null,
    mainRatio: (() => {
      const v = pick(6)
      return v != null ? v / 100 : null
    })(),
    sourceLabel: '数据源：东方财富 fflow（push2his 历史镜像）',
    methodologyNote:
      '主力 = 超大单 + 大单，单位元；不同数据商口径不同，本文使用东财口径。历史日期数据从 push2his 历史镜像取，与当日实时有微小偏差。',
  }
  return flow
}

/** 龙虎榜席位类型识别（外资：常见外资投行营业部关键字；机构专用：含「机构专用」字样） */
const FOREIGN_NAMES = [
  '高盛', '瑞银', '摩根大通', '摩根士丹利', '美林', '巴克莱', '花旗', '汇丰',
  '渣打', '大摩', '小摩', 'J.P.', 'JP', '摩根', '高盛高华',
]
function lhbSeatType(name: string): LhbSeatType {
  if (!name) return 'other'
  if (name.includes('机构专用') || name.includes('机构席位')) return 'institutional'
  if (FOREIGN_NAMES.some((k) => name.includes(k))) return 'foreign'
  return 'other'
}

/** 龙虎榜（当日，可能多原因多条）+ 席位明细 + 机构/外资分组 + 近 30 天历史 */
async function fetchLhb(symbol: string, date: string): Promise<StockReport['lhb'] | null> {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const code = codeOf(symbol)
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`)

  // 当日明细（取近 60 天按日期倒序，够建「近 10 次上榜历史」）
  const listJson = await fetchJson<{
    result?: { data?: Record<string, unknown>[] }
  }>(`${base}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=${filter}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=30&pageNumber=1`)

  const allRows = listJson?.result?.data ?? []
  const todayRows = allRows.filter((r) => String(r.TRADE_DATE ?? '').slice(0, 10) === date)
  if (!todayRows.length) return null

  const items = todayRows.map((r) => ({
    reason: String(r.EXPLANATION ?? ''),
    buyYi: yi(num(r.BILLBOARD_BUY_AMT)) ?? 0,
    sellYi: yi(num(r.BILLBOARD_SELL_AMT)) ?? 0,
    netYi: yi(num(r.BILLBOARD_NET_AMT)) ?? 0,
    dealAmtYi: yi(num(r.BILLBOARD_DEAL_AMT)) ?? 0,
    buyRatio: num(r.BUY_RATIO) != null ? num(r.BUY_RATIO)! / 100 : null,
  }))

  // 近 1 月上榜次数
  const now = new Date(date)
  const from = new Date(now)
  from.setDate(from.getDate() - 30)
  const count30d = allRows.filter((r) => {
    const d = String(r.TRADE_DATE ?? '').slice(0, 10)
    return d >= ymd(from) && d <= date
  }).length

  // 近 10 次上榜历史（去重同一天多原因，只保留一条合并原因）
  const seenDates = new Map<string, { date: string; reason: string; netYi: number; changePct: number | null }>()
  for (const r of allRows) {
    const d = String(r.TRADE_DATE ?? '').slice(0, 10)
    if (!d) continue
    if (seenDates.has(d)) continue
    const reasons = allRows
      .filter((x) => String(x.TRADE_DATE ?? '').slice(0, 10) === d)
      .map((x) => String(x.EXPLANATION ?? ''))
      .filter(Boolean)
    const changeRatePct = num(r.CHANGE_RATE)
    seenDates.set(d, {
      date: d,
      reason: reasons.join('；'),
      netYi: yi(num(r.BILLBOARD_NET_AMT)) ?? 0,
      changePct: changeRatePct != null ? changeRatePct / 100 : null,
    })
    if (seenDates.size >= 10) break
  }
  const history = Array.from(seenDates.values()).sort((a, b) => (a.date < b.date ? 1 : -1))

  // 买卖席位前五 + 拉全量（不只是 top5）以完整识别外资/机构
  const seatFilter = encodeURIComponent(`(SECURITY_CODE="${code}")(TRADE_DATE='${date}')`)
  const [buyRes, sellRes] = await Promise.allSettled([
    fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
      `${base}?reportName=RPT_BILLBOARD_DAILYDETAILSBUY&columns=ALL&filter=${seatFilter}&pageSize=50&pageNumber=1`,
    ),
    fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
      `${base}?reportName=RPT_BILLBOARD_DAILYDETAILSSELL&columns=ALL&filter=${seatFilter}&pageSize=50&pageNumber=1`,
    ),
  ])

  const rawBuy: Record<string, unknown>[] =
    buyRes.status === 'fulfilled' ? (buyRes.value?.result?.data ?? []) : []
  const rawSell: Record<string, unknown>[] =
    sellRes.status === 'fulfilled' ? (sellRes.value?.result?.data ?? []) : []

  // 汇总：按席位名聚合净额 = 买入金额 - 卖出金额
  const sumMap = new Map<
    string,
    { name: string; buy: number; sell: number; net: number; riseProb3d: number | null }
  >()
  const acc = (r: Record<string, unknown>, kind: 'buy' | 'sell') => {
    const name = String(r.OPERATEDEPT_NAME ?? '').trim()
    if (!name) return
    const amt = yi(num(kind === 'buy' ? r.BUY : r.SELL)) ?? 0
    const probRaw = num(r.RISE_PROBABILITY_3DAY)
    const prob = probRaw != null && probRaw > 1 ? probRaw : probRaw != null ? probRaw * 100 : null
    const cur = sumMap.get(name) ?? { name, buy: 0, sell: 0, net: 0, riseProb3d: null }
    if (kind === 'buy') cur.buy += amt
    else cur.sell += amt
    cur.net = cur.buy - cur.sell
    if (prob != null) cur.riseProb3d = prob
    sumMap.set(name, cur)
  }
  rawBuy.forEach((r) => acc(r, 'buy'))
  rawSell.forEach((r) => acc(r, 'sell'))

  const allSeats: LhbSeat[] = Array.from(sumMap.values())
    .filter((s) => s.name)
    .map((s) => ({
      name: s.name,
      amtYi: Number(s.net.toFixed(4)),
      riseProb3d: s.riseProb3d,
      type: lhbSeatType(s.name),
    }))

  const buySeats = allSeats.filter((s) => s.amtYi > 0).sort((a, b) => b.amtYi - a.amtYi).slice(0, 5)
  const sellSeats = allSeats.filter((s) => s.amtYi < 0).sort((a, b) => a.amtYi - b.amtYi).slice(0, 5)

  // 机构/外资分组（汇总各自分组，不只 top5）
  const groupBy = (type: LhbSeatType) =>
    allSeats
      .filter((s) => s.type === type)
      .map((s) => ({ name: s.name, netYi: s.amtYi, riseProb3d: s.riseProb3d }))
      .sort((a, b) => Math.abs(b.netYi) - Math.abs(a.netYi))

  return {
    items,
    buySeats,
    sellSeats,
    institutional: groupBy('institutional'),
    foreign: groupBy('foreign'),
    history,
    count30d: count30d > 0 ? count30d : null,
  }
}

/** 融资融券（T+1 披露，取最新一条 + 连续净偿还天数） */
async function fetchRzrq(symbol: string): Promise<StockReport['rzrq'] | null> {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const filter = encodeURIComponent(`(scode="${codeOf(symbol)}")`)
  const json = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&filter=${filter}&sortColumns=date&sortTypes=-1&pageSize=10&pageNumber=1`,
  )
  const rows = json?.result?.data ?? []
  if (!rows.length) return null
  const latest = rows[0]
  // 连续净偿还（RZJME<0）天数：从最新往前数
  let downDays = 0
  for (const r of rows) {
    const jme = num(r.RZJME)
    if (jme != null && jme < 0) downDays++
    else break
  }
  return {
    date: String(latest.DATE ?? '').slice(0, 10),
    rzyeYi: yi(num(latest.RZYE)),
    rzjmeYi: yi(num(latest.RZJME)),
    rzmreYi: yi(num(latest.RZMRE)),
    rzcheYi: yi(num(latest.RZCHE)),
    rqylWan: num(latest.RQYL) != null ? Number((num(latest.RQYL)! / 1e4).toFixed(2)) : null,
    downDays: downDays > 0 ? downDays : 0,
  }
}

/** 大宗交易（近 5 条） */
async function fetchBlockTrades(symbol: string): Promise<StockReport['blockTrades'] | null> {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const filter = encodeURIComponent(`(SECURITY_CODE="${codeOf(symbol)}")`)
  const json = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPT_DATA_BLOCKTRADE&columns=ALL&filter=${filter}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=5&pageNumber=1`,
  )
  const rows = json?.result?.data ?? []
  if (!rows.length) return null
  return rows.map((r) => ({
    date: String(r.TRADE_DATE ?? '').slice(0, 10),
    price: num(r.DEAL_PRICE) ?? 0,
    premiumPct: num(r.PREMIUM_RATIO),
    amountYi: yi(num(r.DEAL_AMT)) ?? 0,
    buyer: r.BUYER_NAME ? String(r.BUYER_NAME) : null,
    seller: r.SELLER_NAME ? String(r.SELLER_NAME) : null,
  }))
}

/** 十大流通股东（最新披露期） */
async function fetchHolders(symbol: string): Promise<StockReport['holders'] | null> {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const secucode = symbol.toLowerCase().replace(/^(sh|sz)/, '$1.') // sh603248 → sh.603248? 接口要 603248.SH
  const sc = `${codeOf(symbol)}.${symbol.toLowerCase().startsWith('sh') ? 'SH' : 'SZ'}`
  void secucode
  const filter = encodeURIComponent(`(SECUCODE="${sc}")`)
  const json = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPT_F10_EH_FREEHOLDERS&columns=ALL&filter=${filter}&sortColumns=END_DATE,HOLDER_RANK&sortTypes=-1,1&pageSize=10&pageNumber=1`,
  )
  const rows = json?.result?.data ?? []
  if (!rows.length) return null
  // 第一条即最新披露期的 rank1，过滤同一期
  const reportDate = String(rows[0].END_DATE ?? '').slice(0, 10)
  const sameTerm = rows.filter((r) => String(r.END_DATE ?? '').slice(0, 10) === reportDate)
  return sameTerm.slice(0, 10).map((r) => ({
    name: String(r.HOLDER_NAME ?? ''),
    holdNumWan: num(r.HOLD_NUM) != null ? Number((num(r.HOLD_NUM)! / 1e4).toFixed(2)) : 0,
    ratio: num(r.FREE_HOLDNUM_RATIO) != null ? num(r.FREE_HOLDNUM_RATIO)! / 100 : null,
    changeWan: (() => {
      const c = r.HOLD_NUM_CHANGE
      if (c == null) return null
      if (String(c) === '新进') return null
      // HOLD_NUM_CHANGE 单位是「股」，转万股（fmtWan 直接展示，不再换算）
      const n = num(c)
      return n != null ? Number((n / 1e4).toFixed(2)) : null
    })(),
    state: String(r.HOLDER_STATEE ?? r.HOLDER_STATE ?? '不变'),
    type: r.HOLDER_TYPE ? String(r.HOLDER_TYPE) : null,
    reportDate,
  }))
}

/** 日 K（近 300 根，不复权）—— 技术指标 + 交易日校验 */
async function fetchDailyKline(symbol: string): Promise<{
  date: string; open: number; close: number; high: number; low: number
}[]> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidOf(symbol)}` +
    `&klt=101&fqt=0&lmt=300&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55`
  const json = await fetchJson<{ data?: { klines?: string[] } }>(url)
  const rows = json?.data?.klines ?? []
  if (rows.length < 30) throw new Error('日K数据不足')
  // 行格式：日期,开,收,高,低
  return rows
    .map((r) => {
      const p = r.split(',')
      return { date: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]) }
    })
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
}

// ===== 技术指标（本地计算） =====
function calcTech(bars: { close: number; high: number; low: number }[]): StockReport['tech'] {
  const closes = bars.map((b) => b.close)
  const n = closes.length

  // Wilder RSI
  const rsi = (period: number): number | null => {
    if (n < period + 1) return null
    let gain = 0
    let loss = 0
    for (let i = n - period; i < n; i++) {
      const d = closes[i] - closes[i - 1]
      if (d > 0) gain += d
      else loss -= d
    }
    const avgG = gain / period
    const avgL = loss / period
    if (avgL === 0) return 100
    return Number((100 - 100 / (1 + avgG / avgL)).toFixed(1))
  }

  // KDJ(9,3,3)
  let k = 50
  let d = 50
  if (n >= 9) {
    for (let i = 8; i < n; i++) {
      let hh = -Infinity
      let ll = Infinity
      for (let j = i - 8; j <= i; j++) {
        hh = Math.max(hh, bars[j].high)
        ll = Math.min(ll, bars[j].low)
      }
      const rsv = hh > ll ? ((closes[i] - ll) / (hh - ll)) * 100 : 50
      k = (2 / 3) * k + (1 / 3) * rsv
      d = (2 / 3) * d + (1 / 3) * k
    }
  }
  const j = 3 * k - 2 * d

  // BOLL(20,2)
  const bollUp: number | null = (() => {
    if (n < 20) return null
    const s = closes.slice(-20)
    const mid = s.reduce((a, b) => a + b, 0) / 20
    const std = Math.sqrt(s.reduce((a, b) => a + (b - mid) ** 2, 0) / 20)
    return Number((mid + 2 * std).toFixed(2))
  })()
  const bollMid: number | null =
    n >= 20 ? Number((closes.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2)) : null
  const bollLow: number | null = (() => {
    if (n < 20) return null
    const s = closes.slice(-20)
    const mid = s.reduce((a, b) => a + b, 0) / 20
    const std = Math.sqrt(s.reduce((a, b) => a + (b - mid) ** 2, 0) / 20)
    return Number((mid - 2 * std).toFixed(2))
  })()

  const ma = (p: number): number | null =>
    n >= p ? Number((closes.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(2)) : null

  return {
    rsi6: rsi(6),
    rsi12: rsi(12),
    rsi24: rsi(24),
    kdjK: Number(k.toFixed(1)),
    kdjD: Number(d.toFixed(1)),
    kdjJ: Number(j.toFixed(1)),
    bollUp,
    bollMid,
    bollLow,
    ma5: ma(5),
    ma20: ma(20),
    ma60: ma(60),
    ma250: ma(250),
  }
}

// ===== 解读要点（规则引擎，不预测涨跌） =====
// 资金流字段单位是「元」，展示转「亿」
const fmtFlowYi = (yuan: number | null): string =>
  yuan == null ? '—' : `${yuan >= 0 ? '+' : ''}${(yuan / 1e8).toFixed(2)} 亿`
// 龙虎榜等已是「亿」单位的值
const fmtYi = (v: number | null): string => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} 亿`)
const fmtWan = (v: number | null): string =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} 万股`

function buildInsights(r: StockReport): string[] {
  const out: string[] = []
  const q = r.quote

  // 1. 日内形态
  if (q) {
    if (q.open > q.prevClose && q.close < q.open && q.changePct != null && q.changePct < 0) {
      out.push('高开低走翻绿收盘，日内抛压重于承接，属于「冲高回落」形态。')
    } else if (q.open < q.prevClose && q.close > q.open && q.changePct != null && q.changePct > 0) {
      out.push('低开高走收红，日内承接强于抛压。')
    }
    if (q.turnoverRate != null && q.turnoverRate >= 30) {
      out.push(`换手率 ${q.turnoverRate.toFixed(2)}%，单日筹码近乎完全换手一遍，持仓成本被快速打散。`)
    } else if (q.turnoverRate != null && q.turnoverRate >= 15) {
      out.push(`换手率 ${q.turnoverRate.toFixed(2)}%，交投显著放大。`)
    }
    if (q.volumeRatio != null && q.volumeRatio >= 2) {
      out.push(`量比 ${q.volumeRatio.toFixed(2)}，成交活跃度是近期的 ${q.volumeRatio.toFixed(1)} 倍以上。`)
    }
  }

  // 2. 资金结构
  const f = r.flow
  if (f) {
    if (f.main != null && f.small != null && f.main < 0 && f.small > 0) {
      out.push(
        `主力净流出 ${fmtFlowYi(f.main)}、散户小单净流入 ${fmtFlowYi(f.small)}，` +
          '筹码由大资金向散户转移，是典型的高位派发结构（与吸筹方向相反）。',
      )
    } else if (f.main != null && f.small != null && f.main > 0 && f.small < 0) {
      out.push(
        `主力净流入 ${fmtFlowYi(f.main)}、散户小单净流出 ${fmtFlowYi(Math.abs(f.small))}，筹码由散户向大资金集中，偏吸筹结构。`,
      )
    } else if (f.main != null) {
      out.push(`主力资金净${f.main >= 0 ? '流入' : '流出'} ${fmtFlowYi(f.main)}。`)
    }
    if (f.main5d != null && f.main != null) {
      if (f.main5d > 0 && f.main < 0) {
        out.push(
          `近 5 日主力仍累计净流入 ${fmtFlowYi(f.main5d)}，但当日单日回吐 ${fmtFlowYi(Math.abs(f.main)).replace('+', '')}，注意资金退潮是否延续（单日不算趋势）。`,
        )
      } else if (f.main5d < 0 && f.main > 0) {
        out.push(`近 5 日主力累计净流出 ${fmtFlowYi(f.main5d)}，当日转为净流入，观察是否出现承接。`)
      }
    }
    if (f.super != null && f.main != null && Math.abs(f.super) > Math.abs(f.main) * 0.9) {
      out.push(
        `超大单净${f.super >= 0 ? '流入' : '流出'} ${fmtFlowYi(f.super)}，是主力口径的主要构成，大资金方向明确。`,
      )
    }
  }

  // 3. 龙虎榜与主力口径的背离
  const lhb = r.lhb
  if (lhb && lhb.items.length) {
    const net = lhb.items.reduce((a, b) => a + b.netYi, 0)
    if (net > 0 && r.flow?.main != null && r.flow.main < 0) {
      out.push(
        `龙虎榜名义净买入 ${fmtYi(net)} 为正，但主力资金口径净流出，两口径背离——不要只看龙虎榜净买额判断资金态度。`,
      )
    } else if (net < 0) {
      out.push(`龙虎榜净卖出 ${fmtYi(net)}，上榜席位以卖出为主。`)
    }
    if (lhb.count30d != null && lhb.count30d >= 3) {
      out.push(`近 1 月第 ${lhb.count30d} 次上榜，短期博弈激烈。`)
    }
    // 机构专用席位
    if (lhb.institutional.length) {
      const instNet = lhb.institutional.reduce((a, b) => a + b.netYi, 0)
      const dir = instNet >= 0 ? '净买入' : '净卖出'
      out.push(
        `当日机构专用席位 ${lhb.institutional.length} 家上榜，合计${dir} ${fmtYi(instNet)}。`,
      )
    } else if (lhb.items.length) {
      out.push('当日上榜席位中未出现「机构专用」席位。')
    }
    // 外资席位
    if (lhb.foreign.length) {
      const forNet = lhb.foreign.reduce((a, b) => a + b.netYi, 0)
      const dir = forNet >= 0 ? '净买入' : '净卖出'
      out.push(
        `外资席位 ${lhb.foreign.length} 家（${lhb.foreign.map((f) => f.name).join('、')}）${dir} ${fmtYi(forNet)}。`,
      )
    }
    // 上榜历史趋势
    if (lhb.history.length >= 2) {
      const recent = lhb.history.slice(0, 3)
      const buyDays = recent.filter((h) => h.netYi > 0).length
      const sellDays = recent.length - buyDays
      if (sellDays > buyDays) {
        out.push(
          `近 ${recent.length} 次上榜净买入 / 净卖出 ${buyDays} / ${sellDays} 天，趋势偏卖方。`,
        )
      }
    }
  }

  // 4. 融资融券
  const rz = r.rzrq
  if (rz) {
    if (rz.rzjmeYi != null && rz.rzjmeYi < 0) {
      out.push(
        `融资余额 ${rz.rzyeYi?.toFixed(2) ?? '—'} 亿元，净偿还 ${Math.abs(rz.rzjmeYi).toFixed(2)} 亿元` +
          (rz.downDays != null && rz.downDays >= 2 ? `（已连续 ${rz.downDays} 日净偿还）` : '') +
          '，杠杆资金在撤退。',
      )
    } else if (rz.rzjmeYi != null && rz.rzjmeYi > 0) {
      out.push(`融资净买入 ${rz.rzjmeYi.toFixed(2)} 亿元，杠杆资金仍在加仓。`)
    }
  }

  // 5. 机构/股东动向
  const holders = r.holders
  if (holders && holders.length) {
    const qfiis = holders.filter((h) => h.type === 'QFII')
    const reduced = holders.filter((h) => h.state === '减仓')
    const added = holders.filter((h) => h.state === '加仓')
    if (reduced.length) {
      out.push(
        `最新披露（${holders[0].reportDate}）十大流通股东中 ${reduced.length} 家减仓：` +
          reduced.map((h) => `${h.name} ${fmtWan(h.changeWan)}`).join('、') +
          '。',
      )
    }
    if (qfiis.length) {
      out.push(`十大流通股东中含 QFII ${qfiis.length} 家（${qfiis.map((h) => h.name).join('、')}），外资有参与但需关注其季度增减方向。`)
    }
    if (added.length) {
      out.push(`加仓方：${added.map((h) => `${h.name} ${fmtWan(h.changeWan)}`).join('、')}。`)
    }
  }

  // 6. 技术面
  const t = r.tech
  if (t) {
    if (t.rsi6 != null && t.rsi6 >= 80) out.push(`RSI6 = ${t.rsi6.toFixed(1)}，短线严重超买。`)
    else if (t.rsi6 != null && t.rsi6 <= 20) out.push(`RSI6 = ${t.rsi6.toFixed(1)}，短线严重超卖。`)
    if (t.kdjJ != null && t.kdjJ >= 100) out.push(`KDJ 的 J 值 ${t.kdjJ.toFixed(1)}，超买钝化区。`)
    else if (t.kdjJ != null && t.kdjJ <= 0) out.push(`KDJ 的 J 值 ${t.kdjJ.toFixed(1)}，超卖区。`)
    if (q && t.bollUp != null && q.close > t.bollUp) {
      out.push(`收盘价 ${q.close.toFixed(2)} 站上布林上轨（${t.bollUp}），波动率极端放大。`)
    }
    if (q && t.ma250 != null) {
      out.push(
        q.close >= t.ma250
          ? `收盘价在年线 MA250（${t.ma250}）之上。`
          : `收盘价已跌破年线 MA250（${t.ma250}）。`,
      )
    }
  }

  // 7. 估值提示（只列示，不与行业均值比较——行业均值数据源不稳定）
  if (q?.peTtm != null && q.pb != null) {
    out.push(`估值参考：PE(TTM) ${q.peTtm.toFixed(2)} / PB ${q.pb.toFixed(2)}。`)
  }

  if (!out.length) out.push('当日无明显信号，各板块数据见上。')
  out.push('以上为规则化数据解读，仅供参考，不构成投资建议。市场有风险，投资需谨慎。')
  return out
}

// ===== 报告生成 =====
async function buildReport(symbol: string, today: string): Promise<StockReport> {
  const missing: string[] = []
  const report: StockReport = {
    symbol,
    name: symbol,
    date: today,
    generatedAt: new Date().toISOString(),
    quote: null,
    flow: null,
    lhb: null,
    rzrq: null,
    blockTrades: null,
    holders: null,
    tech: null,
    insights: [],
    missing,
  }

  // 日 K 先行：交易日校验 + 技术指标
  let bars: Awaited<ReturnType<typeof fetchDailyKline>> | null = null
  try {
    bars = await fetchDailyKline(symbol)
    report.tech = calcTech(bars)
  } catch {
    missing.push('日K/技术指标')
  }

  // 快照（同时拿名称）
  let name = symbol
  try {
    const snap = await fetchSnapshot(symbol)
    report.quote = snap.quote
    name = snap.name
  } catch {
    missing.push('行情快照')
  }

  const sections: [string, () => Promise<void>][] = [
    [
      '资金流向',
      async () => {
        report.flow = await fetchFlow(symbol, today)
      },
    ],
    [
      '龙虎榜',
      async () => {
        const v = await fetchLhb(symbol, today)
        if (v) report.lhb = v
      },
    ],
    [
      '融资融券',
      async () => {
        const v = await fetchRzrq(symbol)
        if (v) report.rzrq = v
      },
    ],
    [
      '大宗交易',
      async () => {
        const v = await fetchBlockTrades(symbol)
        if (v) report.blockTrades = v
      },
    ],
    [
      '十大流通股东',
      async () => {
        const v = await fetchHolders(symbol)
        if (v) report.holders = v
      },
    ],
  ]

  await Promise.all(
    sections.map(async ([label, fn]) => {
      try {
        await fn()
      } catch {
        missing.push(label)
      }
    }),
  )

  report.name = name
  report.insights = buildInsights(report)
  return report
}

// ===== 15:01 调度器 =====
const SCHEDULE_HOUR = 15
const SCHEDULE_MINUTE = 1
const SCHEDULE_RETRY_UNTIL = 15 * 60 + 10 // 15:10 前允许重试（等收盘数据落库）
const CHECK_INTERVAL = 30 * 1000

function scheduleTick(): void {
  const now = new Date()
  const day = now.getDay()
  if (day === 0 || day === 6) return // 周末跳过
  const hm = now.getHours() * 60 + now.getMinutes()
  if (hm < SCHEDULE_HOUR * 60 + SCHEDULE_MINUTE || hm > SCHEDULE_RETRY_UNTIL) return

  const s = store
  if (!s || s.symbols.length === 0) return
  // 今天 15:00 后已成功生成过就不再执行（防日K落库延迟导致重复触发）
  if (s.lastRunAt && Date.now() - s.lastRunAt < 12 * 3600 * 1000) return

  console.log(`[股票分析] 定时任务触发（${ymd(now)} 15:01），开始生成 ${s.symbols.length} 只标的报告`)
  void triggerRun(s.symbols)
}

async function triggerRun(symbols: string[], overrideDate?: string): Promise<StockReportDay | null> {
  if (running) return null
  running = true
  try {
    const s = await loadStore()
    s.symbols = symbols.length ? symbols : s.symbols
    if (!s.symbols.length) return null
    // 交易日判定：手动指定 > 日K最后日期 > 今天（节假日手动触发时取最近交易日）
    let tradeDate = overrideDate ?? ymd(new Date())
    if (!overrideDate) {
      try {
        const bars = await fetchDailyKline(s.symbols[0])
        if (bars.length) tradeDate = bars[bars.length - 1].date
      } catch {
        // 日K失败按今天处理，快照仍可能有数据
      }
    }
    const reports: StockReport[] = []
    for (const sym of s.symbols) {
      try {
        reports.push(await buildReport(sym, tradeDate))
        console.log(`[股票分析] ${sym} 完成`)
      } catch (err) {
        console.error(`[股票分析] ${sym} 失败:`, err instanceof Error ? err.message : err)
      }
    }
    if (!reports.length) return null
    const date = reports[0].date
    const day: StockReportDay = { date, generatedAt: new Date().toISOString(), reports }
    s.days[date] = day
    s.lastRunAt = Date.now()
    await saveStore()
    console.log(`[股票分析] ${date} 报告已生成：${reports.length} 只`)
    return day
  } finally {
    running = false
  }
}

// ===== Vite 插件 =====
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export function stockAnalysisPlugin(): Plugin {
  return {
    name: 'stock-analysis-middleware',
    configureServer(server) {
      // 启动调度器（dev server 常驻，start-server.vbs 保证开机自启）
      void loadStore().then(() => {
        setInterval(scheduleTick, CHECK_INTERVAL)
        console.log('[股票分析] 调度器已启动：交易日 15:01 自动生成')
      })

      server.middlewares.use('/api/stockanalysis', async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')

        // GET：?date=YYYY-MM-DD 返回当日报告；无参数返回全部概览
        if (req.method === 'GET') {
          const s = await loadStore()
          const date = url.searchParams.get('date')
          if (date) {
            const day = s.days[date]
            if (!day) {
              res.writeHead(404)
              res.end(JSON.stringify({ error: '当日无报告' }))
              return
            }
            res.end(JSON.stringify(day))
          } else {
            const dates = Object.keys(s.days).sort().reverse()
            res.end(
              JSON.stringify({
                symbols: s.symbols,
                dates,
                latest: dates.length ? s.days[dates[0]] : null,
              }),
            )
          }
          return
        }

        // PUT：同步跟踪列表（前端每次变更跟踪股票时上报）
        if (req.method === 'PUT') {
          try {
            const parsed = JSON.parse(await readBody(req))
            if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
              throw new Error('期望字符串数组')
            }
            const s = await loadStore()
            s.symbols = parsed.filter((x: string) => /^(sh|sz)\d{6}$/i.test(x))
            await saveStore()
            res.end(JSON.stringify({ ok: true, symbols: s.symbols }))
          } catch (err) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
          }
          return
        }

        // POST：手动触发生成（body 可选 { symbols?: string[], date?: 'YYYY-MM-DD' }）
        if (req.method === 'POST') {
          let symbols: string[] = []
          let overrideDate: string | undefined
          try {
            const body = await readBody(req)
            if (body) {
              const parsed = JSON.parse(body)
              if (Array.isArray(parsed?.symbols)) symbols = parsed.symbols
              if (typeof parsed?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
                overrideDate = parsed.date
              }
            }
          } catch {
            // 空体/非法体忽略，用已存列表
          }
          const day = await triggerRun(symbols, overrideDate)
          if (!day) {
            res.writeHead(502)
            res.end(JSON.stringify({ error: '生成失败：无可用数据' }))
            return
          }
          res.end(JSON.stringify(day))
          return
        }

        res.writeHead(405)
        res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      })
    },
  }
}
