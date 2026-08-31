/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { prep, startSession, continueSession } from './_setup'

// 长程"马拉松":在**同一个会话**里连续跑很多个小任务,维护一份不断增长的 ledger.txt,
// 让上下文持续累积 → 反复触发 compaction。采下整段累积的 SSE 帧。
// 轮数由 CAPTURE_TURNS 控制(默认 20)。每轮都逼一次 bash 工具调用。
// 韧性:某轮超时/失败就停在那里、保存已采到的帧,不硬性 fail —— 便于观察后端能撑多长。
const OUT = 'capture/golden-master'
const TURNS = Math.max(1, Number(process.env.CAPTURE_TURNS ?? 20))

/**
 * 等"第 n 轮结束"(done 帧数 >= n)。轮询期间若冒出 bash 审批 HITL(即使 auto 模式,后端选择性
 * 确认层也会拦某些命令),自动点「允许」放行,让马拉松不因无人审批而卡死。
 */
async function waitTurn(page: Page, n: number, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const dones = await page.evaluate(
      () => ((window as any).__sseDump ?? []).filter((e: any) => e.frame?.type === 'done').length,
    )
    if (dones >= n) { await page.waitForTimeout(600); return }
    // 有待审批 → 自动放行(选择性确认层偶尔拦命令)
    const allow = page.getByRole('button', { name: '允许' })
    if (await allow.count() > 0) {
      try { await allow.first().click({ timeout: 4000 }) } catch { /* 竞态:按钮消失就算了 */ }
    }
    await page.waitForTimeout(1200)
  }
  throw new Error(`waitTurn: 等 done #${n} 超时`)
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

/** 第 k 个任务的指令。混合几类任务(追加/汇总/建文件/核对),既长又不流于重复。 */
function taskFor(k: number): string {
  if (k % 10 === 0)
    return `第 ${k} 个任务:用 bash 统计 ledger.txt 目前的总行数,把行数告诉我,并简述目前进度。`
  if (k % 5 === 0)
    return `第 ${k} 个任务:用 bash 读取 ledger.txt 的最后 5 行,汇总到目前为止都记录了哪些任务。`
  if (k % 7 === 0)
    return `第 ${k} 个任务:用 bash 创建文件 task-${k}.txt 写入 "checkpoint ${k}",再读出来确认。`
  return `第 ${k} 个任务:用 bash 往 ledger.txt 追加一行 "task-${k}: value=${k * k}",然后读回该文件的最后一行确认。`
}

test('07-long-horizon', async ({ page }) => {
  test.setTimeout(Math.max(900_000, TURNS * 90_000)) // 每轮约 90s 预算,下限 15 分钟

  await prep(page)

  let completed = 0
  try {
    // 第 1 轮:开会话 + 初始化 ledger.txt
    await startSession(page,
      '我们要在这个会话里连续完成很多个小任务,每个任务都必须用 bash 实际操作、不要只口头描述。' +
      '第 1 个任务:创建 ledger.txt 并写入第一行 "task-1: value=1",然后读出来确认。')
    await waitTurn(page, 1)
    completed = 1
    console.log(`[marathon] 1/${TURNS} done`)

    for (let k = 2; k <= TURNS; k++) {
      await continueSession(page, taskFor(k))
      await waitTurn(page, k)
      completed = k
      if (k % 5 === 0 || k === TURNS) console.log(`[marathon] ${k}/${TURNS} done`)
    }
  } catch (e) {
    console.log(`[marathon] 在第 ${completed + 1} 轮停下(超时/失败):${String(e).slice(0, 140)}`)
  }

  const d = await dump(page)
  save('07-long-horizon', d)
  const ty = types(d)
  const dones = (d as any[]).filter(e => e.frame.type === 'done').length
  const toolCalls = (d as any[]).filter(e => e.frame.type === 'tool_call').length
  const compactions = (d as any[]).filter(e => e.frame.type === 'memory_compacted').length
  const sids = new Set((d as any[]).map(e => e.sessionId).filter(Boolean))
  console.log(`[marathon] 完成 ${completed}/${TURNS} 轮 | frames=${d.length} dones=${dones} tool_calls=${toolCalls} compactions=${compactions} sessions=${sids.size}`)
  console.log('07-long-horizon types:', JSON.stringify(ty))

  // 断言:同一会话、确实跑了很多轮、有大量真实工具调用。
  expect(sids.size).toBe(1)                       // 全程同一会话
  expect(completed).toBeGreaterThanOrEqual(Math.min(TURNS, 10)) // 至少跑够一批
  expect(toolCalls).toBeGreaterThan(0)
})
