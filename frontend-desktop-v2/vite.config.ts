import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'path'

// 与 electron/branding.json 的 backendPort 保持一致（现为 17926）。**别用 15926**——
// 那是上一代 IPMaster-Cowork 的端口，占上会与旧版互相串台（见 branding.json 注释）。
// 后端起在别的端口时用 BACKEND_PORT 环境变量覆盖。
const backendPort = process.env.BACKEND_PORT ?? '17926'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        // pdfjs CMaps — required so CJK (Chinese) PDFs render glyphs correctly.
        // v4 preserves source dir structure by default; stripBase:true flattens so
        // the .bcmap files land directly in `<dist>/cmaps/`.
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps', rename: { stripBase: true } },
      ],
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api/v1/sessions': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache'
            }
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
