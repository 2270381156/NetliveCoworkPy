import { defineConfig } from '@playwright/test'

// Step 0c:对**真实后端**(:15926)驱动采集 golden-master fixtures。
// 与 visual 基线不同——这里 NOT mock /api,Vite dev 代理 /api → 15926(见 vite.config)。
const PORT = 5181

export default defineConfig({
  testDir: './capture',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 150_000, // 真 LLM,单场景留足时间
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
