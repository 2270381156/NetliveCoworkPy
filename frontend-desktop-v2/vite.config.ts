import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'path'

const backendPort = process.env.BACKEND_PORT ?? '15926'

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
