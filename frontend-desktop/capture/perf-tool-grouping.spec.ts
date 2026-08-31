/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 性能测试：工具调用分组 + 100+ 轮长程压力
 *
 * 目标：
 *   1. 每轮任务强制触发 3-5 个连续工具调用，验证分组折叠效果
 *   2. 连续跑 PERF_TURNS（默认 100）轮，累积大量历史记录
 *   3. 全程采集 Long Task（> 50ms）和 JS 堆内存，量化"是否卡顿"
 *   4. 结束后测滚动帧率，截图供目视核验
 *
 * 运行方式（需先启动后端 + vite dev）：
 *   npm run capture -- capture/perf-tool-grouping.spec.ts
 *
 * 轮数覆盖：
 *   PERF_TURNS=100 npm run capture -- capture/perf-tool-grouping.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { prep, startSession, continueSession } from './_setup'

const OUT = 'capture/perf-out'
const TURNS = Math.max(1, Number(process.env.PERF_TURNS ?? 100))
// Long Task 阈值（ms）——浏览器规范定义 > 50ms 为 long task，此处用宽松阈值避免误报
const LONG_TASK_MS = 100

// ── 工具调用密集任务序列 ─────────────────────────────────────────────────────
// 每轮都要求 agent 连续完成 3-5 个 bash 操作（连续工具调用），
// 这是验证"N 次工具调用"分组卡片在大量历史下渲染稳定性的核心场景。
function taskFor(k: number): string {
  const mod = k % 5
  if (mod === 0)
    return (
      `第 ${k} 轮（统计汇总）：` +
      `请严格按顺序完成以下 4 步，每步都必须实际调用 bash 工具：` +
      `（1）运行 \`wc -l ledger.txt\` 统计行数；` +
      `（2）运行 \`tail -3 ledger.txt\` 读最后 3 行；` +
      `（3）运行 \`ls -1 *.txt 2>/dev/null | wc -l\` 统计当前目录 txt 文件数；` +
      `（4）运行 \`echo "checkpoint-${k}: $(date +%s)" >> ledger.txt\` 追加一条记录并确认。` +
      `每步用工具实际执行，最后简述结果。`
    )
  if (mod === 1)
    return (
      `第 ${k} 轮（写入 + 校验）：` +
      `请严格按顺序完成以下 3 步，每步都必须实际调用 bash 工具：` +
      `（1）运行 \`echo "task-${k}: ${k * k}" >> ledger.txt\` 追加一行；` +
      `（2）运行 \`grep "task-${k}" ledger.txt\` 验证写入；` +
      `（3）运行 \`wc -l ledger.txt\` 确认文件行数。` +
      `每步用工具实际执行，最后简述结果。`
    )
  if (mod === 2)
    return (
      `第 ${k} 轮（创建 + 读取 + 合并）：` +
      `请严格按顺序完成以下 5 步，每步都必须实际调用 bash 工具：` +
      `（1）运行 \`echo "batch-${k}-a" > batch-${k}.txt\`；` +
      `（2）运行 \`echo "batch-${k}-b" >> batch-${k}.txt\`；` +
      `（3）运行 \`cat batch-${k}.txt\` 读出内容；` +
      `（4）运行 \`cat batch-${k}.txt >> ledger.txt\` 合并到 ledger；` +
      `（5）运行 \`tail -2 ledger.txt\` 确认合并结果。` +
      `每步用工具实际执行，最后简述结果。`
    )
  if (mod === 3)
    return (
      `第 ${k} 轮（计算 + 追加 + 验证）：` +
      `请严格按顺序完成以下 4 步，每步都必须实际调用 bash 工具：` +
      `（1）运行 \`echo $((${k} * ${k} + ${k}))\` 计算结果；` +
      `（2）运行 \`echo "calc-${k}: $((${k} * ${k} + ${k}))" >> ledger.txt\`；` +
      `（3）运行 \`grep "calc-${k}" ledger.txt\`；` +
      `（4）运行 \`wc -c ledger.txt\` 查看文件字节数。` +
      `每步用工具实际执行，最后简述结果。`
    )
  // mod === 4
  return (
    `第 ${k} 轮（目录扫描 + 写入）：` +
    `请严格按顺序完成以下 3 步，每步都必须实际调用 bash 工具：` +
    `（1）运行 \`ls -la\` 列出当前目录所有文件；` +
    `（2）运行 \`echo "scan-${k}: $(ls | wc -l) files" >> ledger.txt\`；` +
    `（3）运行 \`tail -1 ledger.txt\` 确认追加。` +
    `每步用工具实际执行，最后简述结果。`
  )
}

// ── 等"第 n 轮结束"（done 帧数 >= n），期间自动放行 HITL 审批 ─────────────────
// 用 waitForFunction + polling 代替裸 evaluate，在 Vite HMR 等引发执行上下文销毁时能容错重试。
async function waitTurn(page: Page, n: number, timeout = 480_000) {
  const deadline = Date.now() + timeout
  let lastLog = Date.now()
  let lastDones = 0

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    // waitForFunction 对执行上下文销毁（HMR/reload）有内置容错，比 evaluate 稳健
    // polling: 500ms 检查一次；最多等 2s 再回到外层循环做 HITL 检查
    const handle = await page.waitForFunction(
      (target: number) =>
        ((window as any).__sseDump ?? []).filter((e: any) => e.frame?.type === 'done').length >= target,
      n,
      { timeout: Math.min(2_000, remaining), polling: 500 },
    ).catch(() => null)

    if (handle !== null) { await page.waitForTimeout(500); return }

    // 读取当前 done 数（仅用于日志，失败时忽略）
    lastDones = await page.evaluate(
      () => ((window as any).__sseDump ?? []).filter((e: any) => e.frame?.type === 'done').length,
    ).catch(() => lastDones)

    // 若出现 HITL 审批，自动点「允许」（auto 模式下偶尔仍会弹出确认）
    const allow = page.getByRole('button', { name: '允许' })
    if (await allow.count() > 0) {
      try { await allow.first().click({ timeout: 3000 }) } catch { /* 竞态忽略 */ }
    }
    // 每 60s 打印一次等待日志 + SSE dump 摘要，便于诊断
    if (Date.now() - lastLog > 60_000) {
      const summary = await page.evaluate(() => {
        const d = (window as any).__sseDump ?? []
        const counts: Record<string, number> = {}
        for (const e of d) {
          const t = e?.frame?.type ?? 'unknown'
          counts[t] = (counts[t] ?? 0) + 1
        }
        return { total: d.length, counts }
      }).catch(() => ({ total: -1, counts: {} }))
      process.stderr.write(`[perf] 等第 ${n} 轮…已等 ${Math.round((Date.now() - (deadline - timeout)) / 1000)}s，dones=${lastDones} dump=${summary.total} types=${JSON.stringify(summary.counts)}\n`)
      lastLog = Date.now()
    }
  }
  throw new Error(`waitTurn: 等 done #${n} 超时 (${timeout}ms)`)
}

// ── 性能采样 ──────────────────────────────────────────────────────────────────

interface PerfSample {
  turn: number
  domNodes: number
  toolCallCards: number   // 工具调用分组卡片数（新 UI：一组 = 1 张卡）
  heapMB: number | null
  longTasksSoFar: number  // 累计 long task 数
}

async function sample(page: Page, turn: number): Promise<PerfSample> {
  return page.evaluate((t) => {
    const m = (performance as any).memory
    return {
      turn: t,
      domNodes: document.querySelectorAll('*').length,
      // 计算页面上工具分组卡片数（通过卡片内"次工具调用"文字识别）
      toolCallCards: document.body.innerText.split('次工具调用').length - 1,
      heapMB: m ? Math.round(m.usedJSHeapSize / 1024 / 1024) : null,
      longTasksSoFar: (window as any).__longTaskCount ?? 0,
    }
  }, turn)
}

// ── 主测试 ───────────────────────────────────────────────────────────────────

test('perf:tool-grouping-100-turns', async ({ page }) => {
  test.setTimeout(Math.max(TURNS * 480_000, 3_600_000)) // 每轮 8 分钟预算，下限 60 分钟

  // 注入 Long Task 计数器（PerformanceObserver），在 prep 的 addInitScript 之前追加
  await page.addInitScript(() => {
    ;(window as any).__longTaskCount = 0
    try {
      const obs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration > (window as any).__longTaskMs) {
            ;(window as any).__longTaskCount++
          }
        }
      })
      obs.observe({ type: 'longtask', buffered: true })
    } catch { /* 浏览器不支持 longtask 时静默跳过 */ }
    ;(window as any).__longTaskMs = 100
  })

  await prep(page)

  // 记录页面导航事件，辅助诊断执行上下文销毁原因（如 Vite HMR 触发的全量 reload）
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log(`[perf] PAGE NAVIGATED → ${frame.url()}`)
    }
  })

  const samples: PerfSample[] = []
  mkdirSync(OUT, { recursive: true })

  let completed = 0
  try {
    // 第 1 轮：初始化 ledger.txt，2 步（简短，避免首轮超时）
    await startSession(page,
      '我们要在同一个会话里连续完成很多轮任务，每轮都用 bash 实际操作。\n' +
      '第 1 轮：请用 bash 完成以下 2 步：' +
      '（1）运行 `echo "task-1: value=1" > ledger.txt`；' +
      '（2）运行 `cat ledger.txt` 读出内容确认。' +
      '每步都必须实际调用 bash 工具，最后告诉我结果。'
    )
    await waitTurn(page, 1, 600_000)  // 首轮给 10 分钟（含页面加载 + 首次 LLM 冷启动）
    completed = 1
    samples.push(await sample(page, 1))
    console.log(`[perf] 1/${TURNS} done | domNodes=${samples[0].domNodes} heap=${samples[0].heapMB}MB longTasks=${samples[0].longTasksSoFar}`)

    for (let k = 2; k <= TURNS; k++) {
      process.stderr.write(`[perf] sending turn ${k}/${TURNS}...\n`)
      await continueSession(page, taskFor(k))
      process.stderr.write(`[perf] waiting turn ${k}/${TURNS}...\n`)
      await waitTurn(page, k)
      completed = k

      // 每 10 轮采样一次
      if (k % 10 === 0 || k === TURNS) {
        const s = await sample(page, k)
        samples.push(s)
        console.log(
          `[perf] ${k}/${TURNS} done | domNodes=${s.domNodes} toolCards=${s.toolCallCards} heap=${s.heapMB}MB longTasks=${s.longTasksSoFar}`,
        )
        // 每 20 轮截图一次
        if (k % 20 === 0 || k === TURNS) {
          await page.screenshot({ path: `${OUT}/turn-${String(k).padStart(3, '0')}.png`, fullPage: false })
        }
      }
    }
  } catch (e) {
    console.log(`[perf] 在第 ${completed + 1} 轮停下：${String(e).slice(0, 200)}`)
    // 截图记录失败现场
    await page.screenshot({ path: `${OUT}/failure-at-turn-${completed + 1}.png`, fullPage: false })
  }

  // ── 滚动性能测试 ─────────────────────────────────────────────────────────────
  // 完成轮次后，测量滚动列表的帧耗时（用 requestAnimationFrame 统计）
  const scrollPerfMs = await page.evaluate(async () => {
    const scroller = document.querySelector('.overflow-y-auto') as HTMLElement | null
    if (!scroller) return null

    return new Promise<number>((resolve) => {
      scroller.scrollTo({ top: 0 })
      const frameTimes: number[] = []
      let last = performance.now()
      let frame = 0

      function tick() {
        const now = performance.now()
        frameTimes.push(now - last)
        last = now
        frame++
        if (frame < 60) {
          scroller.scrollBy({ top: 100 })
          requestAnimationFrame(tick)
        } else {
          const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
          resolve(Math.round(avg * 10) / 10)
        }
      }
      requestAnimationFrame(tick)
    })
  })

  // ── 最终数据汇总 ──────────────────────────────────────────────────────────────
  const finalDump = await page.evaluate(() => (window as any).__sseDump ?? [])
  const totalToolCalls = (finalDump as any[]).filter(e => e.frame?.type === 'tool_call').length
  const totalDones = (finalDump as any[]).filter(e => e.frame?.type === 'done').length
  const finalLongTasks = await page.evaluate(() => (window as any).__longTaskCount ?? 0)
  const finalSample = samples[samples.length - 1]

  const report = {
    completedTurns: completed,
    targetTurns: TURNS,
    totalToolCalls,
    totalDones,
    finalDomNodes: finalSample?.domNodes ?? null,
    finalToolCallCards: finalSample?.toolCallCards ?? null,
    finalHeapMB: finalSample?.heapMB ?? null,
    totalLongTasks: finalLongTasks,
    longTaskThresholdMs: LONG_TASK_MS,
    scrollAvgFrameMs: scrollPerfMs,
    samples,
  }

  writeFileSync(`${OUT}/perf-report.json`, JSON.stringify(report, null, 2))

  console.log('\n── 性能报告 ─────────────────────────────────────────────')
  console.log(`完成轮数:      ${completed} / ${TURNS}`)
  console.log(`总工具调用:    ${totalToolCalls} 次`)
  console.log(`工具分组卡片:  ${finalSample?.toolCallCards ?? '?'} 张（应 ≈ 完成轮数）`)
  console.log(`DOM 节点数:    ${finalSample?.domNodes ?? '?'}`)
  console.log(`JS 堆:         ${finalSample?.heapMB ?? '?'} MB`)
  console.log(`Long Task 数:  ${finalLongTasks}（> ${LONG_TASK_MS}ms）`)
  console.log(`滚动平均帧耗:  ${scrollPerfMs ?? '?'} ms（< 16.7ms 为 60fps）`)
  console.log('────────────────────────────────────────────────────────\n')

  // ── 断言 ──────────────────────────────────────────────────────────────────────
  // 至少跑够一半轮次（网络/LLM 偶发超时容忍）
  expect(completed).toBeGreaterThanOrEqual(Math.floor(TURNS * 0.5))
  // 确实触发了大量工具调用
  expect(totalToolCalls).toBeGreaterThan(completed * 2) // 平均每轮 > 2 个工具调用
  // 工具卡片数 ≤ 总工具调用数（每个工具调用最多单独成一张卡，不会爆炸）
  if (finalSample?.toolCallCards != null && totalToolCalls > 0) {
    expect(finalSample.toolCallCards).toBeGreaterThan(0)
    expect(finalSample.toolCallCards).toBeLessThanOrEqual(totalToolCalls)
  }
  // 滚动帧耗时 < 33ms（至少 30fps），超过说明卡顿
  if (scrollPerfMs !== null) {
    expect(scrollPerfMs).toBeLessThan(33)
  }
})
