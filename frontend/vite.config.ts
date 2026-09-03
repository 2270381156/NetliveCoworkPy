import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// 与 electron/branding.json 的 backendPort 保持一致（现为 17926）。**别用 15926**——
// 那是上一代 IPMaster-Cowork 的端口，占上会与旧版互相串台（见 branding.json 注释）。
// 后端起在别的端口时用 BACKEND_PORT 环境变量覆盖。
const backendPort = process.env.BACKEND_PORT ?? '17926'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/v1/sessions': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache'
              // When the backend closes the SSE stream, close the client side too.
              // Without this, http-proxy silently keeps the browser connection alive
              // (zombie), so EventSource never fires onerror and won't reconnect.
              proxyRes.on('close', () => res.destroy())
            }
          })
          proxy.on('error', (_err, _req, res) => {
            // Backend unreachable — destroy the client socket so EventSource
            // immediately gets onerror and starts retrying.
            if ('destroy' in res) (res as import('net').Socket).destroy()
          })
        },
      },
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
})
