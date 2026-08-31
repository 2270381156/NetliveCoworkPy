import { defineConfig, devices } from '@playwright/test'

// Step 0b 视觉基线:对关键界面做迁移前后像素 diff。
// 护栏(见 架构文档 §4.2):禁用动画、固定 viewport+deviceScaleFactor、同机基线、mock 数据。
const PORT = 5180

export default defineConfig({
  testDir: './visual',
  // 单一基线文件名(不带平台/项目后缀)——同机基线,提交一份即可。
  snapshotPathTemplate: 'visual/__baseline__/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',   // 冻结 CSS 动画/过渡
      caret: 'hide',            // 隐藏文本光标,避免闪烁差异
      maxDiffPixelRatio: 0.002, // 允许极小 AA 抖动,真实漂移仍会被抓
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
