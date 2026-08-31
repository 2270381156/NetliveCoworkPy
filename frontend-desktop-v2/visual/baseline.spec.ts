import { test, expect, type Page } from '@playwright/test'

// 确定性测试数据(mock 后端,保证可重复、不依赖真后端/真 LLM)。
const PROVIDER = {
  name: 'deepseek',
  style: 'openai',
  base_url: 'https://api.deepseek.com/v1',
  models: [
    { name: 'deepseek-v4-flash', context_limit: 65536 },
    { name: 'deepseek-v4-pro', context_limit: 131072 },
  ],
  default_model: 'deepseek-v4-flash',
  timeout_sec: 120,
}

const SESSIONS = [
  { id: 'ses_a', status: 'DONE', goal: '把数据中心迁移到 SDN', workspace: 'C:/ws/dc', created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-01T12:00:00Z' },
  { id: 'ses_b', status: 'RUNNING', goal: '现网协议采集与分析', workspace: 'C:/ws/probe', created_at: '2026-06-02T09:00:00Z', updated_at: '2026-06-02T09:30:00Z' },
]

async function prep(page: Page, opts: { sessions?: unknown[] } = {}) {
  // 1) 确定性环境:固定语言 zh、注入最小 electronAPI(让登录后的完整 UI 渲染)、
  //    并把所有新手引导(driver.js)标记为已看,避免引导浮层污染截图。
  await page.addInitScript(() => {
    localStorage.setItem('netlive.lang.v1', 'zh')
    for (const t of ['main', 'workspace', 'llm', 'skills']) {
      localStorage.setItem(`onboarding.${t}.v1`, '1')
    }
    // 最小桩:仅 getSession/logout,其余方法保持 undefined(组件内可选链降级)。
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      getSession: async () => ({ id: 'u1', username: 'Tester', role: 'user' }),
      logout: async () => {},
    }
  })
  // 2) Mock 后端:先注册兜底(其余 /api/v1/** 返回 []),再注册具体路由(后注册者优先)。
  await page.route('**/api/v1/**', r => r.fulfill({ json: [] }))
  await page.route('**/api/v1/llms', r => r.fulfill({ json: [PROVIDER] }))
  await page.route('**/api/v1/sessions', r => r.fulfill({ json: opts.sessions ?? [] }))
}

test('landing — 空会话落地页', async ({ page }) => {
  await prep(page)
  await page.goto('/')
  await page.getByTitle('新建会话').waitFor()
  await expect(page).toHaveScreenshot('landing-empty.png')
})

test('sessions — 有会话的侧栏', async ({ page }) => {
  await prep(page, { sessions: SESSIONS })
  await page.goto('/')
  await page.getByText('把数据中心迁移到 SDN').waitFor()
  await expect(page).toHaveScreenshot('sessions-populated.png')
})

test('llm-settings — LLM 账号设置页', async ({ page }) => {
  await prep(page)
  await page.goto('/')
  await page.getByTitle('Tester').click()         // 打开设置弹出菜单
  await page.getByText('LLM 配置').click()          // 进入 LLM 设置页
  await page.getByText('deepseek', { exact: false }).first().waitFor()
  await expect(page).toHaveScreenshot('llm-settings.png')
})
