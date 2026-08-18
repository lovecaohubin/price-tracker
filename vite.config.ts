import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'

// 自定义中间件：用 Node.js 原生 https 获取 K 线数据，绕过代理层限制
function klinePlugin(): Plugin {
  return {
    name: 'kline-middleware',
    configureServer(server) {
      server.middlewares.use('/api/kline', (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`)
        const symbol = url.searchParams.get('symbol')
        const period = url.searchParams.get('period') || 'day'  // day | week

        if (!symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Missing symbol' }))
        }

        // 日线：不设起始日期，2000条（约8年），前复权保证走势连续
        // 周线：从2000年开始，1400条（约27年），用不复权(bfq)计算真实的历史最高/最低价格
        const param = period === 'week'
          ? `${symbol},week,2000-01-01,,1400,bfq`
          : `${symbol},day,,,2000,qfq`
        const apiUrl = `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param}`

        console.log(`[K线中间件] 请求: ${apiUrl}`)
        https.get(apiUrl, {
          headers: {
            'Referer': 'https://gu.qq.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          },
        }, (proxyRes) => {
          let data = ''
          proxyRes.on('data', chunk => data += chunk)
          proxyRes.on('end', () => {
            console.log(`[K线中间件] ${symbol} 状态:${proxyRes.statusCode}, 数据长度:${data.length}`)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(data)
          })
        }).on('error', (err) => {
          console.error(`[K线中间件] ${symbol} 失败:`, err.message)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), klinePlugin()],
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
