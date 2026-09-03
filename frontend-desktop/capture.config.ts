import { defineConfig } from '@playwright/test'

// 对**真实后端**(:17926,见 electron/branding.json)驱动采集 golden-master fixtures / 冒烟截图。
// 与单元测试(vitest, src/**)是两码事——这里不 mock /api,Vite dev 代理 /api → 后端(端口由 vite.config.ts 从 branding 取)。
// SSE 帧采集靠测试侧劫持 EventSource(见 capture/_setup.ts),不改任何产品代码。
const PORT = 5181

export default defineConfig({
  testDir: './capture',
  outputDir: './capture/test-results', // 把 Playwright 产物收进 capture/(由 capture/.gitignore 忽略)
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 150_000, // 真 LLM,单场景留足时间
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    // Per-action timeout: prevents locator.click()/fill() from blocking forever when an
    // element can't be found. Default (0) would inherit the test timeout (up to 60 min).
    actionTimeout: 30_000,
    // 默认用 Playwright 自带 Chromium(需 npx playwright install chromium)。
    // 国内下载慢时,设 CAPTURE_BROWSER_CHANNEL=chrome|msedge 直接用系统已装浏览器,免下载。
    ...(process.env.CAPTURE_BROWSER_CHANNEL ? { channel: process.env.CAPTURE_BROWSER_CHANNEL } : {}),
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
