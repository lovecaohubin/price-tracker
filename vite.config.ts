import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/sina': {
        target: 'http://hq.sinajs.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sina/, ''),
        headers: { Referer: 'https://finance.sina.com.cn' },
      },
      '/api/em': {
        target: 'https://push2his.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/em/, ''),
      },
    },
  },
})
