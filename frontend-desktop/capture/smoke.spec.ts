/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { prep, startSession } from './_setup'

// 驱动真实后端,发各类消息,截图供人工核验前端渲染(代码块、表格、mermaid、工具块、HITL、LLM 设置)。
// window.__sseDump 由 _setup.ts 劫持 EventSource 注入(零产品代码改动);各 wait* 助手轮询它。
const OUT = 'capture/smoke-out'

/** 等待会话"这一轮结束":done 帧,或转入非运行态(纯文本回复会落 PAUSED 而非 done)。 */
async function waitDone(page: Page, timeout = 140_000) {
  await page.waitForFunction(() => {
    const d = (window as any).__sseDump as { frame: any }[] | undefined
    if (!d) return false
    const ended = ['PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED']
    return d.some(e => e.frame?.type === 'done'
      || (e.frame?.type === 'session_update' && ended.includes(e.frame?.status)))
  }, null, { timeout })
  await page.waitForTimeout(1000) // 让最后一帧渲染落定
}

/** 等待 HITL 帧(bash_exec_confirm 或 waiting_input),审批弹层即将出现。 */
async function waitHitl(page: Page, timeout = 90_000) {
  await page.waitForFunction(() => {
    const d = (window as any).__sseDump as { frame: any }[] | undefined
    return !!d && d.some(e => e.frame?.type === 'bash_exec_confirm' || e.frame?.type === 'waiting_input')
  }, null, { timeout })
  await page.waitForTimeout(400) // 等组件渲染
}

/** 等待流式开始:text_delta 或 reasoning_delta(有的模型先出推理再出正文)。 */
async function waitStreamStart(page: Page, timeout = 90_000) {
  await page.waitForFunction(() => {
    const d = (window as any).__sseDump as { frame: any }[] | undefined
    return !!d && d.some(e => e.frame?.type === 'text_delta' || e.frame?.type === 'reasoning_delta')
  }, null, { timeout })
  await page.waitForTimeout(500) // 等至少一个渲染帧
}

function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true })
  return page.screenshot({ path: `${OUT}/${name}.png` })
}

// ─── 对话/渲染类 ────────────────────────────────────────────────────────────

test('smoke:code-and-table', async ({ page }) => {
  await prep(page)
  await startSession(page, '请用 markdown 回答:写一段 Python 快速排序函数(放代码块里),并配一个简短的 markdown 表格说明它的时间复杂度(最好/平均/最坏)。直接回答,简洁。')
  await waitDone(page)
  await shot(page, '01-code-and-table')
})

test('smoke:ascii-diagram', async ({ page }) => {
  await prep(page)
  await startSession(page, '请用一个代码块画一个 ASCII 流程图,描述"用户提问 → Agent 思考 → 调用工具 → 返回结果"的流程。只输出这个代码块。')
  await waitDone(page)
  await shot(page, '02-ascii-diagram')
})

test('smoke:tool-call', async ({ page }) => {
  await prep(page)
  await startSession(page, '请用工具实际读取工作目录下的 topology.txt 文件,并把内容原样告诉我。')
  await waitDone(page)
  await shot(page, '03-tool-call')
})

test('smoke:llm-settings-page', async ({ page }) => {
  await prep(page)
  await page.goto('/')
  await page.getByTitle('Tester').click()
  await page.getByText('LLM 配置').click()
  // 真实后端隐藏 env 自举账号 → 列表为空态;等"添加大模型"按钮即说明页面已渲染。
  await page.getByRole('button', { name: '添加大模型' }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(400)
  await shot(page, '04-llm-settings')
})

// 05: Mermaid 图渲染
// 高价值:mermaid 走自定义渲染路径,须独立核验(旧版曾出现"mermaid 错误渗入应用帧"bug)。
test('smoke:mermaid-in-chat', async ({ page }) => {
  await prep(page)
  await startSession(page,
    '请只输出下面这段内容,不要添加任何说明文字:\n' +
    '```mermaid\n' +
    'flowchart LR\n' +
    '  A[用户提问] --> B[Agent 思考]\n' +
    '  B --> C{需要工具?}\n' +
    '  C -- 是 --> D[调用工具]\n' +
    '  C -- 否 --> E[直接回答]\n' +
    '  D --> E\n' +
    '```'
  )
  await waitDone(page)
  await shot(page, '05-mermaid-in-chat')
})

// 06: HITL bash 审批弹层 + 批准后工具结果
// 高价值:ChatWaitingInput 是独立 UI 组件;审批前/后是两个截然不同的视觉状态。
// 批准按钮文字来自 i18n key `chat.allow` = "允许"。
test('smoke:hitl-confirm-and-done', async ({ page }) => {
  await prep(page)
  await startSession(page, '请用 bash 工具运行命令 echo smoke-hitl-ok,然后把输出告诉我。')
  // 默认 auto 模式会自动放行无害 bash → 不弹审批;立刻切 manual 让每个 bash 都需人工批准。
  await page.waitForFunction(() => !!(window as any).__sseDump?.[0]?.sessionId, null, { timeout: 30_000 })
  const sid = await page.evaluate(() => (window as any).__sseDump[0].sessionId as string)
  await page.evaluate((id) => fetch(`/api/v1/sessions/${id}/bash-review-mode`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }),
  }), sid)
  await waitHitl(page)
  await shot(page, '06a-hitl-confirm')                         // 审批弹层
  await page.getByRole('button', { name: '允许' }).first().click()
  await waitDone(page)
  await shot(page, '06b-hitl-done')                            // 工具调用结果已渲染
})

// 07: 复合 markdown 元素
// 中优先:代码块/表格已有,此处补一级/二级标题、无序/有序列表、引用块、内联代码、hr。
test('smoke:rich-markdown', async ({ page }) => {
  await prep(page)
  await startSession(page,
    '请用 markdown 格式简要介绍 TCP/IP 四层模型,要求包含:\n' +
    '- 一个 # 一级标题\n' +
    '- 每层用 ## 二级标题 + 无序列表描述协议示例\n' +
    '- 至少一处 > 引用块\n' +
    '- 至少一处反引号内联代码\n' +
    '- 最后一条水平线 ---\n' +
    '每层不超过 3 条列表项,保持简洁。'
  )
  await waitDone(page)
  await shot(page, '07-rich-markdown')
})

// 08: AddProviderForm 视图
// 中优先:"添加大模型"表单是独立组件,需要目视验收。文字来自 i18n key `llm.addProvider`。
test('smoke:llm-settings-add-form', async ({ page }) => {
  await prep(page)
  await page.goto('/')
  await page.getByTitle('Tester').click()
  await page.getByText('LLM 配置').click()
  await page.getByRole('button', { name: '添加大模型' }).click()
  // 等表单第一个输入项出现
  await page.getByRole('textbox').first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(400)
  await shot(page, '08-llm-settings-add-form')
})

// 09: 流式输出进行中
// 中优先:对话气泡刚开始流式时的 UI 状态(光标/活动条/首段文字)。
// 截完立即等 done 再拍一张对比:同一会话的"流式中" vs "完成"。
test('smoke:streaming-mid-and-done', async ({ page }) => {
  await prep(page)
  await startSession(page, '请写一段 150 字左右关于量子纠缠的科普文章,不要使用任何工具。')
  await waitStreamStart(page)
  await shot(page, '09a-streaming-mid')
  await waitDone(page)
  await shot(page, '09b-streaming-done')
})
