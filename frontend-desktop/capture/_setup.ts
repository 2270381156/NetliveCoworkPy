/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Page } from '@playwright/test'
import { resolve } from 'node:path'

// 共享启动桩：驱动真实后端发消息前的页面准备。
// WS = agent 工作目录(selectDirectory 桩返回值)。默认仓内 capture/workspace(含 topology.txt/
// ip-plan.txt 等场景所需文件);要换目录用 CAPTURE_WS 环境变量覆盖。
export const WS = process.env.CAPTURE_WS ?? resolve(process.cwd(), 'capture/workspace')

// 可选:经 UI 模型选择器指定 LLM 模型。留空 → 用后端默认账号(faithful,同 forked-ren)。
// 后端默认账号不可用时,设 CAPTURE_LLM_MODEL 为 /llms 里存在的模型名(如 deepseek-v4-pro)即可。
export const MODEL = process.env.CAPTURE_LLM_MODEL ?? ''

/**
 * 页面准备：桩 electronAPI + localStorage,并**劫持 window.EventSource** 把每帧 tee 进
 * window.__sseDump。采集机制完全在测试侧,不改任何产品代码(src/** 零改动)——App 用裸全局
 * `new EventSource(...)`(useSessionSSE.ts),劫持全局即透明生效,产品 hook 照常收帧、互不干扰。
 * dump 每条形如 { sessionId, frame },供各 spec 的 waitForFrame/waitDone/waitHitl 轮询。
 *
 * 关键：清除 netlive.pendingSession.v1 — App 将 pendingSession 持久化到 localStorage，
 * 若上轮测试异常退出(session 已创建但 handleSessionCreated 未被调用)，残留的 pendingSession
 * 会在下次 goto('/') 时让 App 直接进入 pending 模式，干扰新测试的 UI 流程。
 */
export async function prep(page: Page) {
  await page.addInitScript((ws) => {
    // 清除可能残留的 pendingSession（App 将其持久化到 localStorage）
    localStorage.removeItem('netlive.pendingSession.v1')
    localStorage.setItem('netlive.lang.v1', 'zh')
    for (const t of ['main', 'workspace', 'llm', 'skills']) localStorage.setItem(`onboarding.${t}.v1`, '1')
    ;(window as any).electronAPI = {
      getSession: async () => ({ id: 'u1', username: 'Tester', role: 'user' }),
      logout: async () => {},
      selectDirectory: async () => ws,
    }
    // ── SSE 采集钩子:劫持 EventSource,零产品代码改动 ──────────────────────────
    const Orig = window.EventSource
    const dump = ((window as any).__sseDump ??= [] as { sessionId: string; frame: any }[])
    class Tapped extends Orig {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        const m = String(url).match(/\/sessions\/([^/]+)\/stream/)
        const sessionId = m ? m[1] : ''
        this.addEventListener('message', (e: MessageEvent) => {
          try {
            const frame = JSON.parse((e as MessageEvent).data as string)
            if (frame && frame.type !== 'ping') dump.push({ sessionId, frame }) // 滤心跳噪声
          } catch { /* 非 JSON 帧忽略 */ }
        })
      }
    }
    ;(window as any).EventSource = Tapped
  }, WS)
}

/**
 * 新建会话：通过 ChatPanel 中央空态的"新建会话"按钮打开对话框（而非侧边栏按钮，
 * 侧边栏有多个同名按钮易产生歧义）→ 选目录(触发 selectDirectory 桩 → 返回 WS)
 * → 创建会话 → 发第一条消息。
 *
 * 依赖 prep() 清除了 netlive.pendingSession.v1，确保 App 在 goto('/') 后处于
 * !sessionId && !pendingSession 状态（显示"开始对话"空态），中央按钮才会出现。
 */
export async function startSession(page: Page, prompt: string) {
  await page.goto('/')

  // 等待 App 认证完成并渲染 ChatPanel 空态（"开始对话"文字可见）
  await page.waitForSelector('text=开始对话', { timeout: 30_000 })

  // 点 ChatPanel 空态的"新建会话"按钮（setShowNewDialog → ChatPanel 内部 NewSessionDialog）
  // last() 避免歧义：当多个同名按钮存在时取最后一个（侧边栏在前，中央卡片在后）
  await page.getByRole('button', { name: '新建会话', exact: true }).last().click()

  // 等待 NewSessionDialog 渲染
  await page.waitForSelector('text=点击选择目录…', { timeout: 10_000 })

  // 触发 selectDirectory 桩 → electronAPI.selectDirectory() 返回 WS
  await page.getByText('点击选择目录…').click()

  // 等待目录路径在 UI 中反映（确认 setWorkingDir 已生效，避免空目录导致 handleCreate 弹 alert）
  await page.waitForFunction(
    (ws: string) => {
      const name = ws.split(/[\\/]/).filter(Boolean).pop() ?? ''
      return !!name && document.body.innerText.includes(name)
    },
    WS,
    { timeout: 5_000 },
  ).catch(() => { /* 即使目录名未显示也继续，不阻断流程 */ })

  if (MODEL) {
    await page.getByRole('button', { name: '使用默认' }).click()
    await page.getByRole('button', { name: MODEL }).click()
  }

  await page.getByRole('button', { name: '创建会话' }).click()

  // 等待 pending 模式渲染（首条消息输入框出现）
  const ta = page.getByPlaceholder('输入第一条消息（Enter 发送）')
  await ta.waitFor({ timeout: 10_000 })
  await ta.click()
  await ta.fill(prompt)
  await ta.press('Enter')

  // 等待 SSE 连接建立（任意一帧到达）——确认 session 已创建且 EventSource 已接入
  await page.waitForFunction(
    () => ((window as any).__sseDump ?? []).length > 0,
    { timeout: 60_000 },
  )
}

/**
 * 同一会话续发一条消息(长程/多轮任务)。首轮用 startSession,之后每轮用本函数。
 * 首轮后输入框占位符从「输入第一条消息…」变为常规「输入消息…」。会话即使已 SUCCEEDED,
 * 发新消息也会让前端 reconnect → 新 EventSource 仍被 Tapped 采集,__sseDump 跨轮累积。
 */
export async function continueSession(page: Page, text: string) {
  // Wait for the active-session input (not the pending-mode first-message textarea).
  // If the agent is still running the placeholder switches to '等待 Agent 响应…' and
  // the textarea is disabled; waitFor blocks until it becomes interactable.
  const ta = page.getByPlaceholder('输入消息（Enter 发送，Shift+Enter 换行）')
  await ta.waitFor({ state: 'visible', timeout: 60_000 })
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
}
