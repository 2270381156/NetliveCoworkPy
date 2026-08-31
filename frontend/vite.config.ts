import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const backendPort = process.env.BACKEND_PORT ?? '15926'

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
