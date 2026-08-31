/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { prep, startSession } from './_setup'

// 真实后端采集:每个场景一个新 session,跑完读 window.__sseDump(由 _setup.ts 劫持 EventSource 注入)
// 落盘到 capture/golden-master/。采完可挑好的移到 reducer 快照测试夹具(见 README「采完之后」)。
const OUT = 'capture/golden-master'

/** 轮询 dump,直到出现满足 pred 的帧。 */
async function waitForFrame(page: Page, pred: string, timeout = 130_000) {
  await page.waitForFunction(
    (p) => {
      const d = (window as any).__sseDump as { frame: any }[] | undefined
      if (!d) return false
      // eslint-disable-next-line no-new-func
      const f = new Function('frame', `return ${p}`)
      return d.some((e) => { try { return f(e.frame) } catch { return false } })
    },
    pred,
    { timeout },
  )
}

async function dump(page: Page): Promise<unknown[]> {
  return await page.evaluate(() => (window as any).__sseDump ?? [])
}

function save(name: string, data: unknown[]) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 2))
}

function types(d: unknown[]) {
  const c: Record<string, number> = {}
  for (const e of d as any[]) c[e.frame.type] = (c[e.frame.type] || 0) + 1
  return c
}

test('01-plain-dialog', async ({ page }) => {
  await prep(page)
  await startSession(page, '用一句话解释什么是 SDN(软件定义网络)。直接回答,不要使用任何工具。')
  await waitForFrame(page, "frame.type === 'done'")
  const d = await dump(page)
  save('01-plain-dialog', d)
  console.log('01-plain-dialog:', d.length, JSON.stringify(types(d)))
  expect(d.length).toBeGreaterThan(0)
})

test('02-tool-call', async ({ page }) => {
  await prep(page)
  await startSession(page, '请用工具实际查看并列出当前工作目录下的所有文件名(不要猜测)。')
  await waitForFrame(page, "frame.type === 'done'")
  const d = await dump(page)
  save('02-tool-call', d)
  console.log('02-tool-call:', d.length, JSON.stringify(types(d)))
  expect(d.length).toBeGreaterThan(0)
})

test('04-hitl', async ({ page }) => {
  await prep(page)
  await startSession(page, '请调用 bash 工具运行命令:echo hello-from-bash,然后把输出告诉我。')
  await waitForFrame(page, "frame.type === 'init'")
  // 立刻切到 manual 模式:否则默认 auto 模式下无害的 in-workspace bash 会被直接放行、不弹审批。
  const sid = await page.evaluate(() => ((window as any).__sseDump?.[0]?.sessionId) as string)
  await page.evaluate((id) => fetch(`/api/v1/sessions/${id}/bash-review-mode`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }),
  }), sid)
  // 等 HITL 审批面板出现 → 点「允许」
  await page.getByRole('button', { name: '允许' }).click({ timeout: 140_000 })
  await waitForFrame(page, "frame.type === 'done'")
  const d = await dump(page)
  save('04-hitl', d)
  console.log('04-hitl:', d.length, JSON.stringify(types(d)))
  expect((d as any[]).some(e => /waiting_input|bash_exec_confirm/.test(e.frame.type))).toBeTruthy()
})

test('05-retry-fail', async ({ page }) => {
  // 需后端用**坏 key + 快速失败 env** 启动(见 README),否则采不到失败/重试帧。
  await prep(page)
  await startSession(page, '你好,请简单回一句话。')
  await waitForFrame(page, "frame.type === 'llm_retry' || frame.type === 'task_failed'", 90_000)
  await page.waitForTimeout(10_000) // 让重试/失败帧落齐
  const d = await dump(page)
  save('05-retry-fail', d)
  console.log('05-retry-fail:', d.length, JSON.stringify(types(d)))
  expect((d as any[]).some(e => /llm_retry|task_failed/.test(e.frame.type))).toBeTruthy()
})

test('03-observer-rounds', async ({ page }) => {
  // 多步任务(读两文件 + 核对),尽量触发 observe/act 多轮 → 探测 observer_* 帧。
  await prep(page)
  await startSession(page, '请分多步完成:先用工具读取工作目录下的 topology.txt,再读取 ip-plan.txt,然后核对两者内容是否一致,不一致就逐条指出差异。')
  await waitForFrame(page, "frame.type === 'done'", 150_000)
  const d = await dump(page)
  save('03-observer-rounds', d)
  console.log('03-observer-rounds:', d.length, JSON.stringify(types(d)))
  expect(d.length).toBeGreaterThan(0)
})

test('06-interrupt-resume', async ({ page }) => {
  // 真实"中断"= 红色 Square → /interrupt → runtime.pause_session() → 会话转 PAUSED(软暂停),
  // 靠发一条新消息续跑(续跑会 reconnect → history 非空,正好测 reducer 的 history 重建)。
  await prep(page)
  // 多步 + 每步 sleep 的 bash 任务 → 任务长时间 RUNNING、且步间有清晰 park 点,确保能在 RUNNING 时中断。
  await startSession(page, '请严格分三步,每步都必须实际调用 bash:第一步运行 `sleep 3 && echo step-1`,第二步运行 `sleep 3 && echo step-2`,第三步运行 `sleep 3 && echo step-3`,最后汇总三步输出。')
  await waitForFrame(page, "frame.type === 'tool_call'", 90_000) // 第一个 bash 完成,任务仍在多轮中
  await page.locator('button:has(.lucide-square)').click({ timeout: 20_000 })
  await waitForFrame(page, "frame.type === 'session_update' && frame.status === 'PAUSED'", 30_000)
  const ta = page.getByPlaceholder('输入消息（Enter 发送，Shift+Enter 换行）')
  await ta.click(); await ta.fill('继续完成,谢谢。'); await ta.press('Enter')
  await waitForFrame(page, "frame.type === 'done'", 150_000)
  const d = await dump(page)
  save('06-interrupt-resume', d)
  console.log('06-interrupt-resume:', d.length, JSON.stringify(types(d)))
  // 关键:出现 PAUSED 状态 + 非空 history(续跑 reconnect 重放已有事件)
  expect((d as any[]).some(e => e.frame.type === 'session_update' && e.frame.status === 'PAUSED')).toBeTruthy()
  expect((d as any[]).some(e => e.frame.type === 'history' && Array.isArray(e.frame.events) && e.frame.events.length > 0)).toBeTruthy()
})
