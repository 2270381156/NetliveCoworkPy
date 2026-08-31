import { describe, expect, it } from 'vitest'
import type { ChatWaitingInput } from '@/hooks/useSessionSSE'
import type { HitlPendingItem } from '@/api/hitl'
import { reconcileFromServer, serverItemToWaiting, upsertPending } from './pendingHitls'

const wi = (over: Partial<ChatWaitingInput>): ChatWaitingInput => ({
  id: over.id ?? 'c1', kind: 'waiting_input', prompt: '', input_type: 'user_input',
  hitl_kind: 'input', task_title: '', created_at: '2026-07-05T00:00:00Z', ...over,
})
const sv = (over: Partial<HitlPendingItem>): HitlPendingItem => ({
  id: over.id ?? 'h1', kind: 'input', status: 'pending', capability_id: 'control:ask_user',
  question: 'q?', task_id: 't1', session_id: 's1', agent_id: '', form: 'question',
  arguments: {}, questions: [], created_at: '2026-07-05T00:00:01Z', ...over,
})

describe('upsertPending', () => {
  it('按 hitl_id 去重更新,按 created_at 升序', () => {
    const a = wi({ id: 'c1', hitl_id: 'h1', created_at: '2026-07-05T00:00:02Z' })
    const b = wi({ id: 'c2', hitl_id: 'h2', created_at: '2026-07-05T00:00:01Z' })
    const list = upsertPending(upsertPending([], a), b)
    expect(list.map(x => x.hitl_id)).toEqual(['h2', 'h1'])           // 最老在前
    const a2 = wi({ id: 'c3', hitl_id: 'h1', prompt: 'updated', created_at: a.created_at })
    const list2 = upsertPending(list, a2)
    expect(list2).toHaveLength(2)
    expect(list2.find(x => x.hitl_id === 'h1')!.prompt).toBe('updated')
  })
  it('无 hitl_id 的旧事件按客户端 id 去重追加', () => {
    const legacy = wi({ id: 'c9' })
    const list = upsertPending(upsertPending([], legacy), legacy)
    expect(list).toHaveLength(1)
  })
})

describe('serverItemToWaiting', () => {
  it('映射齐全:hitl_id/form/hitl_kind/prompt/arguments/questions', () => {
    const w = serverItemToWaiting(sv({ id: 'h9', kind: 'approval', form: 'approval',
      question: 'Allow?', arguments: { cmd: 'ls' }, questions: [{ question: 'q?' }] }))
    expect(w.hitl_id).toBe('h9')
    expect(w.hitl_kind).toBe('approval')
    expect(w.form).toBe('approval')
    expect(w.prompt).toBe('Allow?')
    expect(w.arguments).toEqual({ cmd: 'ls' })
    expect(w.questions).toEqual([{ question: 'q?' }])
  })
})

describe('reconcileFromServer', () => {
  it('服务端为真值:减员删除(含无 id 旧条目)、新增追加、同 id 保留本地对象引用', () => {
    const keep = wi({ id: 'c1', hitl_id: 'h1' })
    const gone = wi({ id: 'c2', hitl_id: 'h2' })
    const legacy = wi({ id: 'c3' })                                  // 无 id 旧条目
    const out = reconcileFromServer([keep, gone, legacy], [sv({ id: 'h1' }), sv({ id: 'h3' })])
    expect(out.map(x => x.hitl_id)).toEqual(['h1', 'h3'])
    expect(out[0]).toBe(keep)                                        // 保引用(React 稳定性)
  })
  it('服务端为空 → 清空', () => {
    expect(reconcileFromServer([wi({ hitl_id: 'h1' })], [])).toEqual([])
  })
})
