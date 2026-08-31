import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rewindApi } from './rewind'
import { rememberSessionBackend } from './backends'

// 检查点存在**跑这个会话的那个后端**上。本分支只有地端（需求 §2.2 不做云地协同），
// 所以这里钉的是"恒为地端"：`api/backends` 是个恒返回本地的桩，接云端时换回真实实现，
// 这几条就该扩成按会话分流。现在钉住它，是因为定址错误全是静默的——曾经写死地端时
// 云端会话拿到 404，可回滚回合集合为空，回退按钮一个都不渲染，表现成"没有回滚功能"
// 而不是报错。

const SES = 'ses_local'

beforeEach(() => {
  localStorage.clear()
  rememberSessionBackend(SES, 'local')
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ checkpoints: [], restored: 0, deleted: 0, unchanged: 0 }),
  })) as unknown as typeof fetch)
})

const urlOf = (call: number = 0) => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[call][0] as string

describe('rewind 按会话定址', () => {
  it('列检查点走地端', async () => {
    await rewindApi.listCheckpoints(SES)
    expect(urlOf()).toBe(`/api/v1/rewind/${SES}/checkpoints`)
  })

  it('回滚动作本身发到同一个后端——否则会去改另一个实例的工作区', async () => {
    await rewindApi.restoreToTurn(SES, 3)
    expect(urlOf()).toBe(`/api/v1/rewind/${SES}/restore-to-turn`)
  })

  it('撤销回滚同理', async () => {
    await rewindApi.undo(SES, 'ckpt-safety-1', 3)
    expect(urlOf()).toBe(`/api/v1/rewind/${SES}/undo`)
  })

  it('没记过后端的会话也走地端，不该拼出畸形 URL', async () => {
    await rewindApi.listCheckpoints('ses_unknown')
    expect(urlOf()).toBe('/api/v1/rewind/ses_unknown/checkpoints')
  })
})
