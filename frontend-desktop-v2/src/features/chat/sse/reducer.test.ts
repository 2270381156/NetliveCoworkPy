import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reduceSse } from './reducer'
import { EMPTY_SSE_STATE, type SSEState } from './types'

// golden-master:把 0c 采集的真实 SSE 帧序列喂给纯 reducer,快照最终状态 + 校验关键不变量。
// fixture 用 fs 读(测试在 node 里跑,cwd=项目根),不进 app 包、也不需 resolveJsonModule。
type Entry = { sessionId: string; frame: Record<string, unknown> }
const dir = join(process.cwd(), 'src/features/chat/sse/__fixtures__')
const load = (name: string): Entry[] => JSON.parse(readFileSync(join(dir, name), 'utf8'))

function fold(entries: Entry[]): SSEState {
  return entries.reduce<SSEState>((s, e) => reduceSse(s, e.frame), EMPTY_SSE_STATE)
}

const FIXTURES = {
  plain: load('01-plain-dialog.json'),
  tool: load('02-tool-call.json'),
  observerRounds: load('03-observer-rounds.json'),      // 真实多轮(observer 裁决走 control_tool_call)
  observerSynth: load('03b-observer-synthetic.json'),   // 合成:覆盖 observer_text_* reducer 分支
  hitl: load('04-hitl.json'),
  retry: load('05-retry-fail.json'),
  interrupt: load('06-interrupt-resume.json'),          // 软暂停 PAUSED + 续跑 reconnect(非空 history)
}

describe('reduceSse — golden-master 快照', () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    it(`folds ${name} 不抛错并产出稳定快照`, () => {
      const final = fold(fx)
      expect(final.session).not.toBeNull()
      // 终态:流式都已清空(done/session_update 收尾)
      expect(final.streamingText).toBeNull()
      expect(final.streamingReasoning).toBeNull()
      expect(final.observerStreamingText).toBeNull()
      expect(final).toMatchSnapshot()
    })
  }
})

describe('reduceSse — 关键不变量', () => {
  it('01-plain:产出至少一条 assistant 文本消息', () => {
    const f = fold(FIXTURES.plain)
    expect(f.items.some(i => i.kind === 'message' && i.role === 'assistant' && i.content.length > 0)).toBe(true)
  })

  it('02-tool-call:产出至少一个 tool_call item', () => {
    const f = fold(FIXTURES.tool)
    expect(f.items.some(i => i.kind === 'tool_call')).toBe(true)
  })

  it('04-hitl:在收到 waiting_input 帧那一刻 waitingInput 被置上(审批面板出现)', () => {
    // 折到第一个 waiting_input/bash_exec_confirm 帧为止
    let s = EMPTY_SSE_STATE
    let sawWaiting = false
    for (const e of FIXTURES.hitl) {
      s = reduceSse(s, e.frame)
      const t = e.frame.type
      if (t === 'waiting_input' || t === 'bash_exec_confirm') { sawWaiting = true; break }
    }
    expect(sawWaiting).toBe(true)
    expect(s.waitingInput).not.toBeNull()
    expect(s.waitingInput?.hitl_kind).toBe('approval')
  })

  it('05-retry-fail:经历了 task_failed,最终不再处于 retrying', () => {
    expect(FIXTURES.retry.some(e => e.frame.type === 'task_failed')).toBe(true)
    const f = fold(FIXTURES.retry)
    expect(f.llmRetrying).toBe(false)
  })

  it('03b-observer-synthetic:observer_text_* 产出 observer_message;observer_reasoning(live)被忽略', () => {
    const f = fold(FIXTURES.observerSynth)
    const obs = f.items.find(i => i.kind === 'observer_message')
    expect(obs).toBeDefined()
    expect(obs && obs.kind === 'observer_message' && obs.content).toBe('任务已达成目标。')
    // 旧码 live 不把 observer 推理并入(白名单 fix #2 待施加)→ 无 reasoning
    expect(obs && obs.kind === 'observer_message' && obs.reasoning).toBeUndefined()
  })

  it('06-interrupt-resume:经历过 PAUSED,且续跑收到非空 history(reducer 重建 items)', () => {
    expect(FIXTURES.interrupt.some(e => e.frame.type === 'session_update' && e.frame.status === 'PAUSED')).toBe(true)
    const nonEmptyHistory = FIXTURES.interrupt.find(e => e.frame.type === 'history' && Array.isArray((e.frame as { events?: unknown[] }).events) && ((e.frame as { events: unknown[] }).events.length > 0))
    expect(nonEmptyHistory).toBeDefined()
    const f = fold(FIXTURES.interrupt)
    expect(f.items.length).toBeGreaterThan(0)
    expect(f.session).not.toBeNull()
  })

  it('live 与 replay 共用同一 reducer:history 帧重建 items 走同一套规则(无专用分叉)', () => {
    // 结构性保证:reduceSse 对 history 帧内部逐事件复用 evtToItem;此处仅断言 history 帧被消费、不抛错。
    const withHistory = FIXTURES.plain.find(e => e.frame.type === 'history')
    expect(withHistory).toBeDefined()
    expect(() => reduceSse(EMPTY_SSE_STATE, withHistory!.frame)).not.toThrow()
  })
})

// finish_task 反转契约(上游 spec 2026-07-01,提交 cbd11f9):control_tool_call 为收尾标记,
// 仅当 tool_name=control__finish_task 且 deliverables_summary 非空时产出一条 role:assistant 气泡,
// 其余静默忽略。现有 fixture 都是旧格式(arguments.result,无 deliverables_summary)→ 只走静默分支,
// 这里合成帧补齐"气泡分支"覆盖(live + history 两路径,与上游 finishBubble.test.tsx 对齐)。
describe('reduceSse — finish_task deliverables_summary 气泡', () => {
  const finishFrame = (summary: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'control_tool_call',
    tool_name: 'control__finish_task',
    arguments: { deliverables_summary: summary },
    created_at: '2026-07-01T00:00:00Z',
    ...extra,
  })

  it('live:非空 deliverables_summary → 一条 assistant 气泡', () => {
    const s = reduceSse(EMPTY_SSE_STATE, finishFrame('已完成:交付了 X、Y、Z。'))
    expect(s.items).toHaveLength(1)
    const it0 = s.items[0]
    expect(it0.kind).toBe('message')
    expect(it0.kind === 'message' && it0.role).toBe('assistant')
    expect(it0.kind === 'message' && it0.content).toBe('已完成:交付了 X、Y、Z。')
    expect(s.seq).toBe(1) // 确定性 id 计数随之自增
  })

  it('live:空/纯空白 summary → 静默忽略(无 item、seq 不动)', () => {
    for (const empty of ['', '   ', undefined, null]) {
      const s = reduceSse(EMPTY_SSE_STATE, finishFrame(empty))
      expect(s.items).toHaveLength(0)
      expect(s.seq).toBe(0)
    }
  })

  it('live:非 finish_task 的 control 工具 → 不产气泡', () => {
    const s = reduceSse(EMPTY_SSE_STATE, finishFrame('x', { tool_name: 'control__delegate' }))
    expect(s.items).toHaveLength(0)
  })

  it('history:回放里的 finish_task 收尾标记同样映射成 assistant 气泡(live=replay 对称)', () => {
    const historyFrame = {
      type: 'history',
      events: [
        { type: 'message', role: 'user', content: '帮我做 X', created_at: '2026-07-01T00:00:00Z' },
        { type: 'control_tool_call', tool_name: 'control__finish_task', arguments: { deliverables_summary: 'X 已交付。' }, created_at: '2026-07-01T00:00:01Z' },
      ],
    }
    const s = reduceSse(EMPTY_SSE_STATE, historyFrame)
    const bubble = s.items.find(i => i.kind === 'message' && i.role === 'assistant')
    expect(bubble && bubble.kind === 'message' && bubble.content).toBe('X 已交付。')
  })
})
