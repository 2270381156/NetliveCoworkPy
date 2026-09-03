import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import fs from 'fs'
import path from 'path'

// 品牌标识唯一来源（与 electron 主进程、PyInstaller spec 同一份文件）。
// 用 fs 读而非 import：vite.config 走 Node ESM，JSON import 需要 import attributes，
// 各 Node 版本支持不一，读文件最稳。
const brandingPath = path.resolve(__dirname, '../electron/branding.json')
const branding = JSON.parse(fs.readFileSync(brandingPath, 'utf-8'))

// 后端端口的唯一来源就是 branding.backendPort（现为 17926）。**绝不回落到 15926**——
// 那是上一代 IPMaster-Cowork 的端口，占上会与旧版互相串台（见 branding.json 注释与
// electron/main.js）。手动把后端起在别的端口时用 BACKEND_PORT 环境变量覆盖。
const backendPort = process.env.BACKEND_PORT ?? String(branding.backendPort)

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
    // index.html 是静态文件，模块里的 branding 到不了 <title>，构建期直接替换。
    {
      name: 'inject-branding-title',
      transformIndexHtml(html: string) {
        return html.replace(
          /<title>[\s\S]*?<\/title>/,
          `<title>${branding.productName} Desktop</title>`,
        )
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 前端读品牌标识走这个别名；JSON 由 Vite 构建期内联，运行期零开销。
      '@branding': brandingPath,
    },
  },
  server: {
    host: '0.0.0.0',
    // branding.json 在 frontend-desktop/ 之外（../electron/），dev server 默认只放行
    // 项目根内的文件，不放行会 403。构建产物不受此限（Rollup 直接打进 bundle）。
    fs: { allow: ['..'] },
    watch: {
      // capture/ は Playwright テスト専用。アプリのソースではないのに Vite に
      // 監視されると .ts ファイル変更のたびに全リロードが走り playwright テストが壊れる。
      ignored: ['**/capture/**'],
    },
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
