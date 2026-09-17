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

async function fetchEastmoneyKline(apiUrl: string): Promise<string> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    await acquire()
    try {
      const resp = await fetch(apiUrl, {
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': '*/*',
        },
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
          const text = await fetchEastmoneyKline(apiUrl)
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

export default defineConfig({
  plugins: [react(), klinePlugin(), tradeLogPlugin()],
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
