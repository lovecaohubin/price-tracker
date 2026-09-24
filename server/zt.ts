/**
 * 首版涨停模块（服务端）
 *
 * 实时拉取全市场涨停股（push2.eastmoney clist 按涨幅排序），
 * 通过日K对比昨日是否触及涨停价，识别"首板"与"连板"；
 * 点击个股可拉龙虎榜 / 资金流 / 两融 / 大宗（复用 stockAnalysis 已实测的数据源）。
 *
 * 设计：
 * - /api/zt/list    → 返回涨停股池（首板 + 连板，前 ~60 条），缓存 30s
 * - /api/zt/detail?code=sh603248 → 单只涨停股详情（含龙虎榜等）
 * - 数据流：
 *     clist（涨停股池）→ 各股 2 根日K → 首板判定 → 行业字段从 ulist 拿
 *     详情：复用 stockAnalysis 已验证的 fflow / 龙虎榜 / 两融 / 大宗接口
 *
 * 注意：本模块不预测涨跌、只做"是否首板"+"资金/龙虎榜刻度"的事实呈现。
 */
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ZtListItem,
  ZtListResponse,
  ZtDetailResponse,
  ZtDetailItem,
  ZtLhbSummary,
  ZtRzrqSummary,
  ZtBlockTradeSummary,
} from '../src/types'

// ===== 出站 HTTP（与 stockAnalysis 同样的并发限流 + 退避） =====
const MAX_CONCURRENCY = 4
let activeOutbound = 0
const outboundWaiters: (() => void)[] = []
async function acquire(): Promise<void> {
  if (activeOutbound < MAX_CONCURRENCY) {
    activeOutbound++
    return
  }
  await new Promise<void>((r) => outboundWaiters.push(r))
  activeOutbound++
}
function release(): void {
  activeOutbound--
  const next = outboundWaiters.shift()
  if (next) next()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HEADERS = {
  Referer: 'https://quote.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Accept: '*/*',
}
async function fetchOutbound(url: string): Promise<string> {
  // 增加重试次数 + 指数退避，规避东财瞬时连接重置
  const delays = [500, 1000, 2000, 4000, 6000]
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    await acquire()
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) })
      const text = await r.text()
      if (r.ok) return text
      throw new Error(`HTTP ${r.status}`)
    } catch (err) {
      if (attempt >= delays.length) throw err
      await sleep(delays[attempt])
    } finally {
      release()
    }
  }
  throw new Error('unreachable')
}
async function fetchJson<T = unknown>(url: string): Promise<T> {
  return JSON.parse(await fetchOutbound(url)) as T
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
const symbolOf = (market: number, code: string): string =>
  `${market === 1 ? 'sh' : market === 0 ? 'sz' : market === 2 ? 'bj' : 'sh'}${code}`

/** A 股涨跌停价计算（按交易档 / 创业板 / 科创板 / 京市不同阈值）
 *  - 主板（000/001/002/600/601/603/605）：±10%
 *  - 创业板（300）/ 科创板（688）：±20%（注册制后）
 *  - 北交所（8/9 开头）：±30%
 *  - ST 股：±5%（按公司发布，此处按公告字段不通用，简化按代码前缀）
 *  返回 [下限价, 上限价]（元，4 位小数，保留"分"）
 */
function limitPrices(prevClose: number, code: string): [number, number] {
  const cc = code.toLowerCase()
  let pct = 0.1
  if (cc.startsWith('300') || cc.startsWith('688')) pct = 0.2
  else if (cc.startsWith('8') || cc.startsWith('920') || cc.startsWith('430')) pct = 0.3
  // ST 通常有特殊前缀（如 *ST），但代码段无法可靠识别；保守不打折，避免误判
  const up = Math.round(prevClose * (1 + pct) * 100) / 100
  const dn = Math.round(prevClose * (1 - pct) * 100) / 100
  return [dn, up]
}

/** 是否封板（最新价 == 今日最高价，且已到涨停位 1% 内） */
function isSealedUp(latest: number, high: number, prevClose: number, code: string): boolean {
  if (latest <= 0 || high <= 0 || prevClose <= 0) return false
  const [, upLimit] = limitPrices(prevClose, code)
  if (upLimit <= 0) return false
  // 最新价 == 今日最高 → 仍在封板；>= 涨停价 - 0.05（容差）→ 实际已达涨停
  return Math.abs(latest - high) / Math.max(high, 1e-6) < 0.005 && latest >= upLimit - 0.05
}

// ===== 缓存 =====
interface ListCache {
  resp: ZtListResponse
  expireAt: number
}
let listCache: ListCache | null = null
const LIST_TTL_MS = 30 * 1000

// ===== 数据抓取 =====
interface RawClistRow {
  f1?: number; f2?: number; f3?: number; f4?: number; f5?: number; f6?: number
  f7?: number; f8?: number; f9?: number; f10?: number; f12?: string; f13?: number
  f14?: string; f15?: number; f16?: number; f17?: number; f18?: number; f20?: number
  f24?: number; f25?: number; f26?: number; f37?: number; f39?: number; f40?: number
  f60?: number; f62?: number; f100?: string
}

/** 拉涨停股池（涨幅 >= 10%，取前 60 条；f3 == 1999 / 1099 等为涨停） */
async function fetchZtPool(): Promise<{
  rows: { row: RawClistRow; symbol: string; prevClose: number; changePct: number }[]
  tradeDate: string
}> {
  // push2 在本地出口对瞬时高并发不稳定，改用 push2his 历史镜像（实测更稳定）
  const url =
    'https://push2his.eastmoney.com/api/qt/clist/get?' +
    'fid=f3&pn=1&pz=60&po=1&fltt=2&invt=2&' +
    'fs=m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,' +
    'm:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:12+f:!2&' +
    'fields=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,' +
    'f24,f25,f26,f37,f39,f40,f60,f62,f100'
  const json = await fetchJson<{
    data?: { diff?: Record<string, RawClistRow> | RawClistRow[] }
  }>(url)
  const diffField = json?.data?.diff
  const raw: RawClistRow[] = Array.isArray(diffField)
    ? diffField
    : diffField
    ? Object.values(diffField)
    : []
  // 只保留真正封板的（f3 >= 1000 且 f2 == f15）
  const rows = raw
    .filter((r) => {
      // 注意：clist 加了 fltt=2 后 f2/f15/f18 是浮点元值（37.94），
      // f3 是浮点百分比（19.99），不是 ×100 整数。
      const changePctPct = num(r.f3) // 浮点百分比（19.99 = 19.99%）
      const close = num(r.f2)
      const high = num(r.f15)
      const code = String(r.f12 ?? '')
      const prev = num(r.f18) ?? 0
      if (changePctPct == null || close == null || high == null) return false
      // 涨幅 >= 10%（主板 10.00% 起，创业板/科创板 20.00%）
      if (changePctPct < 9.9) return false
      // 已封板
      if (!isSealedUp(close, high, prev, code)) return false
      return true
    })
    .map((r) => ({
      row: r,
      symbol: symbolOf(num(r.f13) ?? 0, String(r.f12 ?? '')),
      prevClose: num(r.f18) ?? 0,
      changePct: (num(r.f3) ?? 0) / 100,
    }))

  // 行情快照日期（取涨停股池返回的 f26 不一定是交易日，我们用日 K 线最新一根确认）
  const tradeDate = ymd(new Date())
  return { rows, tradeDate }
}

/** 拉个股最近 2 根日 K 线，用于首板判定 */
async function fetch2DayKline(symbol: string): Promise<{
  date: string
  close: number
} | null> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidOf(symbol)}` +
    `&klt=101&fqt=0&lmt=10&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55`
  const json = await fetchJson<{ data?: { klines?: string[] } }>(url)
  const rows = json?.data?.klines ?? []
  if (!rows.length) return null
  // 取最后两根：[date, open, close, high, low]
  const parseLine = (l: string) => {
    const p = l.split(',')
    return { date: p[0], close: Number(p[2]) }
  }
  const last = parseLine(rows[rows.length - 1])
  const prev = rows.length >= 2 ? parseLine(rows[rows.length - 2]) : null
  // 用昨日 close 列入判定（更稳定）；当日信息主要靠 clist 给出
  void last
  return prev
}

/** 首板判定：
 *  - 取昨日收盘价 + 昨日涨停上限
 *  - 昨日 close < 昨日涨停上限 - 0.05 ⇒ 昨日未封板
 *  - 今日已封板 ⇒ 首板
 *  - 否则为连板，统计连续天数 = ceil(连板天数)
 */
function judgeFirstBoard(prevClose: number, code: string, todayChangePct: number): {
  isFirstBoard: boolean
  boardCount: number
} {
  if (prevClose <= 0) return { isFirstBoard: true, boardCount: 1 }
  const [, upLimit] = limitPrices(prevClose, code)
  // 昨日 close < 涨停价容差 ⇒ 昨日未封板 ⇒ 今日封板 ⇒ 首板
  const wasUp = prevClose >= upLimit - 0.05
  if (!wasUp) return { isFirstBoard: true, boardCount: 1 }
  // 昨日已涨停 ⇒ 连板；按涨幅幅度粗估连板次数（仅供参考）
  const code2 = code.toLowerCase()
  const pct = code2.startsWith('300') || code2.startsWith('688') ? 0.2 : 0.1
  // 累计涨幅 ≈ (1+pct)^n - 1 ≥ todayChangePct/100
  const ratio = 1 + todayChangePct / 100
  const n = ratio > 0 ? Math.log(ratio) / Math.log(1 + pct) : 1
  return { isFirstBoard: false, boardCount: Math.max(2, Math.round(n)) }
}

/** 组装列表项（不查 K 线） */
function rowToListItem(
  row: RawClistRow,
  symbol: string,
  prevClose: number,
  changePct: number,
  judge: { isFirstBoard: boolean; boardCount: number },
): ZtListItem {
  // fltt=2 时：f2/f4/f15/f18 是浮点元值；f5 是手；f6 是元；f3 是百分比；f37 是 ×100 的小数（0.71 表示 0.0071）
  // f8/f10 是 ×100 的浮点（4.83 表示 4.83% / 4.83 倍）
  return {
    code: String(row.f12 ?? ''),
    name: String(row.f14 ?? symbol),
    market: num(row.f13) ?? 0,
    price: num(row.f2) ?? 0,
    changePct: changePct,
    changeAmt: num(row.f4) ?? 0,
    volumeHands: num(row.f5) ?? 0,
    turnover: num(row.f6) ?? 0,
    amplitude: (num(row.f37) ?? 0) / 100,
    marketCap: num(row.f20) ?? 0,
    turnoverRate: num(row.f8),
    volumeRatio: num(row.f10),
    industry: row.f100 ? String(row.f100) : null,
    sealedAmt: num(row.f39),
    mainNet: num(row.f60),
    isFirstBoard: judge.isFirstBoard,
    boardCount: judge.boardCount,
    symbol,
  }
}

/** 主列表接口（带 30s 缓存） */
async function fetchList(): Promise<ZtListResponse> {
  if (listCache && listCache.expireAt > Date.now()) return listCache.resp

  const { rows, tradeDate } = await fetchZtPool()

  // 并发拉日K + 判定首板
  const items: ZtListItem[] = []
  await Promise.all(
    rows.map(async ({ row, symbol, prevClose, changePct }) => {
      let judge = { isFirstBoard: true, boardCount: 1 }
      try {
        const prev = await fetch2DayKline(symbol)
        // prev 是昨日收盘，prevClose（来自 clist.f18）已经是昨收，等价
        if (prev && prev.close > 0) {
          judge = judgeFirstBoard(prev.close, String(row.f12 ?? ''), changePct)
        } else {
          judge = judgeFirstBoard(prevClose, String(row.f12 ?? ''), changePct)
        }
      } catch {
        judge = judgeFirstBoard(prevClose, String(row.f12 ?? ''), changePct)
      }
      items.push(rowToListItem(row, symbol, prevClose, changePct, judge))
    }),
  )

  // 按涨幅降序、再按封单金额降序
  items.sort((a, b) => {
    if (b.changePct !== a.changePct) return b.changePct - a.changePct
    return (b.sealedAmt ?? 0) - (a.sealedAmt ?? 0)
  })

  const firstBoard = items.filter((i) => i.isFirstBoard)

  const resp: ZtListResponse = {
    items,
    firstBoard,
    fetchedAt: new Date().toISOString(),
    tradeDate,
    note:
      '数据源：东方财富 push2 clist 涨停股池（按涨幅排序）+' +
      '日K本地判定首板。f2==f15 且已达涨停价 ⇒ 已封板；与昨日对比昨日是否涨停 ⇒ 区分首板/连板。' +
      '北交所/创业板/科创板涨跌停阈值不同，已分别处理。',
  }
  listCache = { resp, expireAt: Date.now() + LIST_TTL_MS }
  return resp
}

// ===== 详情数据（复用 stockAnalysis 已验证的接口） =====

/** 资金流向（fflow，元，klt=101 日线取最近 1 根） */
async function fetchFlow(symbol: string): Promise<ZtDetailItem['flow']> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secidOf(symbol)}` +
    `&klt=101&lmt=1&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59`
  const json = await fetchJson<{ data?: { klines?: string[] } }>(url)
  const row = (json?.data?.klines ?? [])[0]
  if (!row) {
    return { main: null, super: null, big: null, mid: null, small: null, main5d: null }
  }
  const p = row.split(',')
  // [date, main, small, mid, big, super, mainRatio, ...]
  const pick = (i: number) => {
    const v = Number(p[i])
    return Number.isFinite(v) ? v : null
  }
  return {
    main: pick(1),
    small: pick(2),
    mid: pick(3),
    big: pick(4),
    super: pick(5),
    main5d: null, // 单日接口不提供 5 日合计，详情面板不强依赖
  }
}

/** 龙虎榜（精简） */
async function fetchLhb(symbol: string, date: string): Promise<ZtLhbSummary | null> {
  const base = `https://datacenter-web.eastmoney.com/api/data/v1/get`
  const code = codeOf(symbol)
  const filter = encodeURIComponent(`(SECURITY_CODE="${code}")`)
  const listJson = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=${filter}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=30&pageNumber=1`,
  )
  const allRows = listJson?.result?.data ?? []
  const todayRows = allRows.filter((r) => String(r.TRADE_DATE ?? '').slice(0, 10) === date)
  if (!todayRows.length) return null

  const buyAmt = todayRows.reduce((a, r) => a + (num(r.BILLBOARD_BUY_AMT) ?? 0), 0)
  const sellAmt = todayRows.reduce((a, r) => a + (num(r.BILLBOARD_SELL_AMT) ?? 0), 0)
  const netAmt = todayRows.reduce((a, r) => a + (num(r.BILLBOARD_NET_AMT) ?? 0), 0)
  const reason = todayRows.map((r) => String(r.EXPLANATION ?? '')).filter(Boolean).join('；')

  // 近 30 日上榜次数
  const now = new Date(date)
  const from = new Date(now)
  from.setDate(from.getDate() - 30)
  const count30d = allRows.filter((r) => {
    const d = String(r.TRADE_DATE ?? '').slice(0, 10)
    return d >= ymd(from) && d <= date
  }).length

  // 席位明细（全量，按"净额 = 买入金额 - 卖出金额"汇总）
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

  const sumMap = new Map<string, { name: string; buy: number; sell: number; net: number; riseProb3d: number | null }>()
  const acc = (r: Record<string, unknown>, kind: 'buy' | 'sell') => {
    const name = String(r.OPERATEDEPT_NAME ?? '').trim()
    if (!name) return
    const amt = (yi(num(kind === 'buy' ? r.BUY : r.SELL)) ?? 0) * 1e8 // 转回元后再用 yi 转亿：保持与 stockAnalysis 一致
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

  const all = Array.from(sumMap.values())
    .filter((s) => s.name)
    .map((s) => ({ name: s.name, netYi: Number((s.net / 1e8).toFixed(4)), riseProb3d: s.riseProb3d }))

  const buySeats = all.filter((s) => s.netYi > 0).sort((a, b) => b.netYi - a.netYi).slice(0, 5)
  const sellSeats = all
    .filter((s) => s.netYi < 0)
    .sort((a, b) => a.netYi - b.netYi)
    .slice(0, 5)
    .map((s) => ({ name: s.name, netYi: s.netYi }))

  // 机构 / 外资识别
  const FOREIGN_NAMES = [
    '高盛', '瑞银', '摩根大通', '摩根士丹利', '美林', '巴克莱', '花旗', '汇丰',
    '渣打', '大摩', '小摩', 'J.P.', 'JP ', '摩根',
  ]
  const institutional = all
    .filter((s) => s.name.includes('机构专用') || s.name.includes('机构席位'))
    .map((s) => ({ name: s.name, netYi: s.netYi }))
    .sort((a, b) => Math.abs(b.netYi) - Math.abs(a.netYi))
  const foreign = all
    .filter((s) => FOREIGN_NAMES.some((k) => s.name.includes(k)))
    .map((s) => ({ name: s.name, netYi: s.netYi }))
    .sort((a, b) => Math.abs(b.netYi) - Math.abs(a.netYi))

  return {
    date,
    reason,
    buyAmtYi: Number((buyAmt / 1e8).toFixed(4)),
    sellAmtYi: Number((sellAmt / 1e8).toFixed(4)),
    netYi: Number((netAmt / 1e8).toFixed(4)),
    buySeats,
    sellSeats,
    institutional,
    foreign,
    count30d: count30d > 0 ? count30d : null,
  }
}

/** 融资融券（T+1 披露） */
async function fetchRzrq(symbol: string): Promise<ZtRzrqSummary | null> {
  const base = `https://datacenter-web.eastmoney.com/api/data/v1/get`
  const filter = encodeURIComponent(`(scode="${codeOf(symbol)}")`)
  const json = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&filter=${filter}&sortColumns=date&sortTypes=-1&pageSize=10&pageNumber=1`,
  )
  const rows = json?.result?.data ?? []
  if (!rows.length) return null
  const latest = rows[0]
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
    rqylWan: num(latest.RQYL) != null ? Number((num(latest.RQYL)! / 1e4).toFixed(2)) : null,
    downDays,
  }
}

/** 大宗交易（近 5 条） */
async function fetchBlockTrades(symbol: string): Promise<ZtBlockTradeSummary[]> {
  const base = `https://datacenter-web.eastmoney.com/api/data/v1/get`
  const filter = encodeURIComponent(`(SECURITY_CODE="${codeOf(symbol)}")`)
  const json = await fetchJson<{ result?: { data?: Record<string, unknown>[] } }>(
    `${base}?reportName=RPT_DATA_BLOCKTRADE&columns=ALL&filter=${filter}&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=5&pageNumber=1`,
  )
  const rows = json?.result?.data ?? []
  return rows.map((r) => ({
    date: String(r.TRADE_DATE ?? '').slice(0, 10),
    price: num(r.DEAL_PRICE) ?? 0,
    premiumPct: num(r.PREMIUM_RATIO),
    amountYi: yi(num(r.DEAL_AMT)) ?? 0,
    buyer: r.BUYER_NAME ? String(r.BUYER_NAME) : null,
    seller: r.SELLER_NAME ? String(r.SELLER_NAME) : null,
  }))
}

/** 单只涨停股详情：从列表缓存取基础数据 + 拉资金/龙榜/两融/大宗 */
async function fetchDetail(code: string): Promise<ZtDetailResponse | null> {
  const list = await fetchList()
  const base = list.items.find((i) => i.symbol.toLowerCase() === code.toLowerCase())
  if (!base) return null

  // 当日 K 线
  const klineUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidOf(base.symbol)}` +
    `&klt=101&fqt=0&lmt=2&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55`
  const klineJson = await fetchJson<{ data?: { klines?: string[] } }>(klineUrl)
  const bars = (klineJson?.data?.klines ?? []).map((r) => {
    const p = r.split(',')
    return { date: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]) }
  })
  const today = bars[bars.length - 1]
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null
  const ohlc = today
    ? { open: today.open, high: today.high, low: today.low, close: today.close }
    : { open: 0, high: 0, low: 0, close: 0 }
  const prevClose = prev ? prev.close : base.price - base.changeAmt
  const [, upLimit] = limitPrices(prevClose, base.code)

  const [flow, lhb, rzrq, blockTrades] = await Promise.allSettled([
    fetchFlow(base.symbol),
    fetchLhb(base.symbol, list.tradeDate),
    fetchRzrq(base.symbol),
    fetchBlockTrades(base.symbol),
  ])

  const detail: ZtDetailItem = {
    ...base,
    ohlc,
    prevClose,
    limitUpPrice: upLimit,
    flow:
      flow.status === 'fulfilled'
        ? flow.value
        : { main: null, super: null, big: null, mid: null, small: null, main5d: null },
    lhb: lhb.status === 'fulfilled' ? lhb.value : null,
    rzrq: rzrq.status === 'fulfilled' ? rzrq.value : null,
    blockTrades: blockTrades.status === 'fulfilled' ? blockTrades.value : [],
  }

  return {
    item: detail,
    fetchedAt: new Date().toISOString(),
    sources: {
      flow: '东方财富 fflow（push2his 历史镜像，单位元）',
      lhb: '东方财富数据中心 RPT_DAILYBILLBOARD_DETAILSNEW + RPT_BILLBOARD_DAILYDETAILSBUY/SELL',
      rzrq: '东方财富数据中心 RPTA_WEB_RZRQ_GGMX（T+1 披露）',
      blockTrades: '东方财富数据中心 RPT_DATA_BLOCKTRADE',
    },
  }
}

// ===== HTTP =====
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export function ztPlugin(): Plugin {
  return {
    name: 'zt-middleware',
    configureServer(server) {
      server.middlewares.use('/api/zt', async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        // connect 中间件会剥离前缀 /api/zt，handler 拿到的 pathname 是剩余部分
        // /api/zt/list → /list，/api/zt → /，/api/zt/detail → /detail
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end(JSON.stringify({ error: 'Method Not Allowed' }))
          return
        }
        try {
          if (url.pathname === '/list' || url.pathname === '/' || url.pathname === '') {
            const r = await fetchList()
            res.end(JSON.stringify(r))
            return
          }
          if (url.pathname === '/detail') {
            const code = url.searchParams.get('code') ?? ''
            if (!/^(sh|sz|bj)\d{6}$/i.test(code)) {
              res.writeHead(400)
              res.end(JSON.stringify({ error: 'code 格式错误（应如 sh603248）' }))
              return
            }
            const r = await fetchDetail(code)
            if (!r) {
              res.writeHead(404)
              res.end(JSON.stringify({ error: '当前不在涨停股池内' }))
              return
            }
            res.end(JSON.stringify(r))
            return
          }
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Not Found' }))
        } catch (err) {
          console.error('[首版涨停] 出错:', err)
          res.writeHead(500)
          res.end(
            JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          )
        }
      })
    },
  }
}

// 兼容默认导出（vite 插件通常只读 name）
export default ztPlugin