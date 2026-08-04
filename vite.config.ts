import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 东方财富 - 实时行情（JSON，UTF-8，无乱码）
      '/api/em-quote': {
        target: 'https://push2.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/em-quote/, ''),
      },
      // 东方财富 - K 线数据
      '/api/em-kline': {
        target: 'https://push2his.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/em-kline/, ''),
      },
    },
  },
})
