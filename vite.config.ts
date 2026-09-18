import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// 东方财富 K 线接口对瞬时高并发会做连接重置(RST/UND_ERR_SOCKET)，
// 需要一个全局信号量限制出站并发，并对失败做退避重试
const MAX_CONCURRENCY = 6
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const RETRY_DELAYS = [400, 800, 1600, 3200]  // 4 次退避重试，规避东财瞬时连接重置

const EM_HEADERS = {
  'Referer': 'https://quote.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': '*/*',
}

async function fetchOutbound(apiUrl: string, headers: Record<string, string> = EM_HEADERS): Promise<string> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    await acquire()
    try {
      const resp = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(12000),
      })
      const text = await resp.text()
      if (resp.ok) return text
      throw new Error(`HTTP ${resp.status}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= RETRY_DELAYS.length) throw err
      console.log(`[K线中间件] 出站失败(${msg})，${RETRY_DELAYS[attempt]}ms 后重试 ${attempt + 2}/${RETRY_DELAYS.length + 1}`)
      await sleep(RETRY_DELAYS[attempt])
    } finally {
      release()
    }
  }
  throw new Error('unreachable')
}

// K 线响应内存缓存：前端每 10 秒轮询，若每次都穿透到东财会造成请求风暴
// （出站被限流 → 请求积压 → 浏览器连接被占满 → fetch: Failed to fetch）。
// 日线变化快，缓存 30 秒；周线历史数据几乎不变，缓存 10 分钟。
const klineCache = new Map<string, { text: string; expire: number }>()
const CACHE_TTL_DAY = 30 * 1000
const CACHE_TTL_WEEK = 10 * 60 * 1000

// 自定义中间件：服务端拉取 K 线数据后透传给前端
function klinePlugin(): Plugin {
  return {
    name: 'kline-middleware',
    configureServer(server) {
      server.middlewares.use('/api/kline', async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`)
        const symbol = url.searchParams.get('symbol')
        const period = url.searchParams.get('period') || 'day'  // day | week

        if (!symbol || !/^(sh|sz)\d{6}$/i.test(symbol)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid symbol' }))
          return
        }

        // 腾讯 K 线接口(ifzq.gtimg.cn / web.ifzq.gtimg.cn)会按出口 IP 做 WAF 拦截并返回 501 HTML，
        // 因此改用东方财富 K 线接口。
        // secid: 沪市(sh)→1.xxxxxx，深市(sz)→0.xxxxxx；klt: day→101，week→102
        // fqt=0 不复权，返回真实成交价；周线拉 1500 根，覆盖自 2000 年以来全部周K
        const code = symbol.toLowerCase()
        const secid = `${code.startsWith('sh') ? '1' : '0'}.${code.slice(2)}`
        const klt = period === 'week' ? '102' : '101'
        const lmt = period === 'week' ? '1500' : '300'
        const apiUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=0&lmt=${lmt}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`

        const cached = klineCache.get(apiUrl)
        if (cached && cached.expire > Date.now()) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('X-Kline-Cache', 'HIT')
          res.end(cached.text)
          return
        }

        console.log(`[K线中间件] 请求: ${apiUrl}`)
        try {
          const text = await fetchOutbound(apiUrl)
          console.log(`[K线中间件] ${symbol}(${period}) 成功, 数据长度:${text.length}`)
          klineCache.set(apiUrl, {
            text,
            expire: Date.now() + (period === 'week' ? CACHE_TTL_WEEK : CACHE_TTL_DAY),
          })
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('X-Kline-Cache', 'MISS')
          res.end(text)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[K线中间件] ${symbol}(${period}) 最终失败:`, msg)
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
        }
      })
    },
  }
}

// 交易记录（数据分析板块）落盘文件。
// 原数据一次性从桌面 XLS 导入到此 JSON，此后完全由页面录入维护，不再依赖 XLS。
const TRADELOG_FILE = path.resolve(process.cwd(), 'data', 'tradeLog.json')

function tradeLogPlugin(): Plugin {
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })

  return {
    name: 'trade-log-middleware',
    configureServer(server) {
      server.middlewares.use('/api/tradelog', async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')

        // 读取全部记录
        if (req.method === 'GET') {
          try {
            const text = await fs.promises.readFile(TRADELOG_FILE, 'utf-8')
            res.end(text)
          } catch {
            res.end('[]')
          }
          return
        }

        // 覆盖保存全部记录
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const parsed = JSON.parse(await readBody(req))
            if (!Array.isArray(parsed)) throw new Error('数据格式错误：期望记录数组')
            await fs.promises.mkdir(path.dirname(TRADELOG_FILE), { recursive: true })
            await fs.promises.writeFile(TRADELOG_FILE, JSON.stringify(parsed, null, 1), 'utf-8')
            console.log(`[交易记录中间件] 已保存 ${parsed.length} 条记录`)
            res.end(JSON.stringify({ ok: true, count: parsed.length }))
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('[交易记录中间件] 保存失败:', msg)
            res.writeHead(400)
            res.end(JSON.stringify({ error: msg }))
          }
          return
        }

        res.writeHead(405)
        res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      })
    },
  }
}

// 大盘数据中间件：为「次日仓位建议」提供上证指数、两市成交额、主力资金净流入与均线。
// 东财 push2his（历史 K 线）对同一出口 IP 存在连接重置(RST)，历史行情改用腾讯接口；
// 当日快照与资金流仍走东财 push2（稳定可用）。
// 日 K 会落盘增量维护（见上方"本地行情缓存"），接口不可用时降级读本地并在响应里标记 stale。
const marketCache = new Map<string, { json: string; expire: number }>()
const MARKET_TTL = 60 * 1000

const GTIMG_HEADERS = {
  'Referer': 'https://gu.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': '*/*',
}

// ===== 本地行情缓存（data/marketHistory.json） =====
// 依赖减负：日 K 的历史部分一旦收盘就永不改变，没必要每次开页面都去求腾讯。
// 把日 K 落盘后，只有「尾部需要更新」时才发请求；接口不可用时用本地数据兜底，
// 并在响应里标记 stale，由前端明确提示"这不是实时数据"。
const MARKET_STORE_FILE = path.resolve(process.cwd(), 'data', 'marketHistory.json')
/** 单市场最多保留的日 K 根数 */
const STORE_MAX_BARS = 1200
/** 本地已有足够历史时只补最近 N 根（少发一次请求，就少一次被限流的机会） */
const TAIL_REFRESH_BARS = 40

interface Bar {
  date: string
  open: number
  close: number
  high: number
  low: number
  volumeHand: number
}

/** 当日快照字段（成交额 / 主力资金）不可回溯，存下来供东财接口失败时降级使用 */
interface DailySnapshot {
  date: string
  turnover: number | null
  turnoverSse: number | null
  mainCapital: number | null
  mainCapitalSse: number | null
}

interface MarketStore {
  savedAt: number
  sse: Bar[]
  szse: Bar[]
  snapshot: DailySnapshot | null
}

let store: MarketStore | null = null
let storeLoaded = false

async function loadStore(): Promise<MarketStore | null> {
  if (storeLoaded) return store
  storeLoaded = true
  try {
    const raw = JSON.parse(await fs.promises.readFile(MARKET_STORE_FILE, 'utf-8'))
    if (Array.isArray(raw?.sse) && raw.sse.length) {
      const sse = raw.sse as Bar[]
      store = {
        savedAt: Number(raw.savedAt) || 0,
        sse,
        szse: Array.isArray(raw.szse) ? raw.szse : [],
        snapshot: raw.snapshot ?? null,
      }
      console.log(`[大盘中间件] 本地行情缓存已载入：${sse.length} 根日 K（截至 ${sse[sse.length - 1].date}）`)
    }
  } catch {
    // 首次运行没有缓存文件是正常情况
    store = null
  }
  return store
}

async function saveStore(): Promise<void> {
  if (!store) return
  try {
    await fs.promises.mkdir(path.dirname(MARKET_STORE_FILE), { recursive: true })
    await fs.promises.writeFile(
      MARKET_STORE_FILE,
      JSON.stringify({ ...store, savedAt: Date.now() }),
      'utf-8',
    )
  } catch (err) {
    console.warn('[大盘中间件] 本地缓存写入失败:', err instanceof Error ? err.message : err)
  }
}

/** 合并新旧日 K：同一天以新数据为准（盘中会变），按日期升序并裁剪到上限 */
function mergeBars(oldBars: Bar[], freshBars: Bar[], max = STORE_MAX_BARS): Bar[] {
  const map = new Map(oldBars.map((b) => [b.date, b]))
  for (const b of freshBars) map.set(b.date, b)
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-max)
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 本地缓存是否已含「当前可用的最新交易日」 */
function cacheIsFresh(lastDate: string): boolean {
  const now = new Date()
  if (lastDate === ymd(now)) return true
  // 收盘（15:05）前，上一交易日的收盘价就是最新可用数据，不必再为今天拉一次
  if (now.getHours() * 60 + now.getMinutes() < 15 * 60 + 5) {
    const d = new Date(now)
    do {
      d.setDate(d.getDate() - 1)
    } while (d.getDay() === 0 || d.getDay() === 6)
    return lastDate === ymd(d)
  }
  return false
}

type HistorySource = 'network' | 'disk' | 'stale'

/**
 * 取上证 / 深证日 K：优先用本地缓存，必要时增量更新，失败则降级。
 * 返回的序列已按请求长度裁剪。
 */
async function ensureHistory(days: number): Promise<{
  sse: Bar[]
  szse: Bar[]
  source: HistorySource
  staleReason?: string
}> {
  const cached = await loadStore()
  const covers = !!cached && cached.sse.length >= days
  if (covers && cacheIsFresh(cached!.sse[cached!.sse.length - 1].date)) {
    return { sse: cached!.sse.slice(-days), szse: cached!.szse, source: 'disk' }
  }

  const sseCount = covers ? TAIL_REFRESH_BARS : days
  const szseCount = covers ? TAIL_REFRESH_BARS : days
  try {
    const [sseFresh, szseFresh] = await Promise.all([
      fetchTencentDaily('sh000001', sseCount),
      fetchTencentDaily('sz399001', szseCount),
    ])
    if (sseFresh.length < 2) throw new Error('上证指数历史数据不足')
    store = {
      savedAt: Date.now(),
      sse: mergeBars(cached?.sse ?? [], sseFresh),
      szse: mergeBars(cached?.szse ?? [], szseFresh),
      snapshot: cached?.snapshot ?? null,
    }
    storeLoaded = true
    void saveStore()
    return { sse: store.sse.slice(-days), szse: store.szse, source: 'network' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (cached && cached.sse.length >= 6) {
      const last = cached.sse[cached.sse.length - 1].date
      console.warn(`[大盘中间件] 行情接口失败（${msg}），降级使用本地缓存（截至 ${last}）`)
      return { sse: cached.sse.slice(-days), szse: cached.szse, source: 'stale', staleReason: msg }
    }
    throw err
  }
}

// 腾讯日 K：data[symbol].day = [[日期, 开, 收, 高, 低, 成交量(手)], ...]
async function fetchTencentDaily(symbol: string, days: number) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`
  const json = JSON.parse(await fetchOutbound(url, GTIMG_HEADERS))
  const rows: string[][] = json?.data?.[symbol]?.day ?? []
  return rows
    .map((r) => ({
      date: String(r[0]),
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volumeHand: Number(r[5]),
    }))
    .filter((r) => Number.isFinite(r.close) && r.close > 0)
}

// 东财 fltt=2：价格与涨跌幅直接是浮点（无需再除 100）
async function fetchEmQuote(secids: string) {
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f6,f12,f14`
  const json = JSON.parse(await fetchOutbound(url))
  return (json?.data?.diff ?? []) as { f12: string; f2: number; f3: number; f6: number }[]
}

// 指数级资金流接口只返回当日一条，f52 为主力净流入（元）
async function fetchEmMainCapital(secid: string): Promise<number | null> {
  const url = `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}&klt=101&lmt=1&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55`
  const json = JSON.parse(await fetchOutbound(url))
  const row: string | undefined = json?.data?.klines?.[0]
  if (!row) return null
  const v = Number(row.split(',')[1])
  return Number.isFinite(v) ? v : null
}

const meanOf = (arr: number[], n: number): number | null => {
  const s = arr.slice(-n)
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null
}

const round = (v: number | null, digits = 4): number | null =>
  v == null ? null : Number(v.toFixed(digits))

function marketPlugin(): Plugin {
  return {
    name: 'market-middleware',
    configureServer(server) {
      server.middlewares.use('/api/market', async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`)
        const days = Math.min(800, Math.max(6, Number(url.searchParams.get('days')) || 120))

        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const cached = marketCache.get(String(days))
        if (cached && cached.expire > Date.now()) {
          res.setHeader('X-Market-Cache', 'HIT')
          res.end(cached.json)
          return
        }

        try {
          const hist = await ensureHistory(days)
          const sseDays = hist.sse
          const szseDays = hist.szse

          // 当日快照与资金流来自东财：K 线已经够模型用了，这里失败不该让整个接口失败
          const [quoteRes, sseFundRes, szseFundRes] = await Promise.allSettled([
            fetchEmQuote('1.000001,0.399001'),
            fetchEmMainCapital('1.000001'),
            fetchEmMainCapital('0.399001'),
          ])
          const quotes = quoteRes.status === 'fulfilled' ? quoteRes.value : []
          const sseFund = sseFundRes.status === 'fulfilled' ? sseFundRes.value : null
          const szseFund = szseFundRes.status === 'fulfilled' ? szseFundRes.value : null
          if (quoteRes.status === 'rejected') {
            console.warn('[大盘中间件] 成交额快照失败:', quoteRes.reason?.message ?? quoteRes.reason)
          }

          const last = sseDays[sseDays.length - 1]
          const prev = sseDays[sseDays.length - 2]
          const lastSzse = szseDays[szseDays.length - 1]
          const closes = sseDays.map((r) => r.close)

          const sseQ = quotes.find((x) => x.f12 === '000001')
          const szseQ = quotes.find((x) => x.f12 === '399001')
          // 统一先换算成「亿元」口径，便于与本地快照混用
          const freshTurnoverSse = sseQ && Number.isFinite(sseQ.f6) ? sseQ.f6 / 1e8 : null
          const freshTurnoverSzse = szseQ && Number.isFinite(szseQ.f6) ? szseQ.f6 / 1e8 : null
          const freshCapitalSse = sseFund != null ? sseFund / 1e8 : null
          const freshCapitalSzse = szseFund != null ? szseFund / 1e8 : null

          let turnover =
            freshTurnoverSse != null && freshTurnoverSzse != null
              ? freshTurnoverSse + freshTurnoverSzse
              : null
          let turnoverSse: number | null = freshTurnoverSse
          let mainCapital =
            freshCapitalSse != null && freshCapitalSzse != null ? freshCapitalSse + freshCapitalSzse : null
          let mainCapitalSse: number | null = freshCapitalSse

          // 东财取不到时，用同一交易日存下的快照兜底（成对替换，避免沪深两市混用不同来源）
          let snapshotFromCache = false
          const snap = store?.snapshot
          if (snap && snap.date === last.date) {
            if (turnover == null) {
              turnover = snap.turnover
              turnoverSse = snap.turnoverSse
              snapshotFromCache = true
            }
            if (mainCapital == null) {
              mainCapital = snap.mainCapital
              mainCapitalSse = snap.mainCapitalSse
              snapshotFromCache = true
            }
          }

          const degraded: string[] = []
          if (hist.source === 'stale') degraded.push(`行情接口不可用（${hist.staleReason}），日 K 取自本地缓存`)
          if (snapshotFromCache) degraded.push('资金流接口不可用，成交额 / 主力资金取本地同交易日快照')
          const note = degraded.length ? degraded.join('；') : undefined

          // 当日快照落盘：只在数据完整时存，供下次接口失败时兜底
          if (
            store &&
            freshTurnoverSse != null &&
            freshTurnoverSzse != null &&
            freshCapitalSse != null &&
            freshCapitalSzse != null
          ) {
            const r2 = (v: number) => Number(v.toFixed(2))
            store.snapshot = {
              date: last.date,
              turnover: r2(freshTurnoverSse + freshTurnoverSzse),
              turnoverSse: r2(freshTurnoverSse),
              mainCapital: r2(freshCapitalSse + freshCapitalSzse),
              mainCapitalSse: r2(freshCapitalSse),
            }
            void saveStore()
          }

          const payload = {
            date: last.date,
            fetchedAt: Date.now(),
            sse: {
              close: last.close,
              open: last.open,
              high: last.high,
              low: last.low,
              prevClose: prev.close,
              changePct: round(prev.close ? (last.close - prev.close) / prev.close : null, 6),
              amplitude: round(last.low > 0 ? (last.high - last.low) / last.low : null, 6),
              closePosition: round(
                last.high > last.low ? (last.close - last.low) / (last.high - last.low) : 0.5,
                4,
              ),
            },
            szse: {
              close: lastSzse?.close ?? null,
              changePct: szseQ && Number.isFinite(szseQ.f3) ? round(szseQ.f3 / 100, 6) : null,
            },
            // 两市成交额（亿元），与录入口径一致（沪 + 深）
            turnover: round(turnover, 2),
            turnoverSse: round(turnoverSse, 2),
            // 两市主力净流入（亿元）
            mainCapital: round(mainCapital, 2),
            mainCapitalSse: round(mainCapitalSse, 2),
            // 数据来源：network=本次实时拉取，disk=本地缓存，stale=接口失败降级
            source: hist.source,
            stale: hist.source === 'stale' || snapshotFromCache,
            note,
            ma5: round(meanOf(closes, 5), 2),
            ma10: round(meanOf(closes, 10), 2),
            ma20: round(meanOf(closes, 20), 2),
            // 上证近 N 日序列：前端补齐「次日涨跌」用于回测验证
            history: sseDays.map((r, i) => ({
              date: r.date,
              close: r.close,
              open: r.open,
              high: r.high,
              low: r.low,
              changePct:
                i > 0 && sseDays[i - 1].close
                  ? round((r.close - sseDays[i - 1].close) / sseDays[i - 1].close, 6)
                  : null,
              volumeHand: r.volumeHand,
            })),
          }

          const json = JSON.stringify(payload)
          marketCache.set(String(days), { json, expire: Date.now() + MARKET_TTL })
          res.setHeader('X-Market-Cache', 'MISS')
          res.end(json)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[大盘中间件] 获取失败:', msg)
          res.writeHead(502)
          res.end(JSON.stringify({ error: msg }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), klinePlugin(), tradeLogPlugin(), marketPlugin()],
  server: {
    proxy: {
      // 腾讯股票API - 实时行情（UTF-8）
      '/api/gtimg': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/gtimg/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Referer', 'https://gu.qq.com/')
          })
        },
      },
    },
  },
})
