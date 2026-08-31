import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hitlApi } from './hitl'
import { rememberSessionBackend } from './backends'

// 审批单（agent 停下来问你的那一问）存在**跑这条会话的那个后端**上。本分支只有地端
// （需求 §2.2 不做云地协同），所以这里钉的是"恒为地端"——`api/backends` 是个恒返回
// 本地的桩，接云端时换回真实实现，这几条就该扩成按会话分流。
//
// 定址错误在这里不会明着坏：地端对不认识的 hitlId 返 404，调用方 catch 住退回旧通道，
// 界面上什么都看不出来。所以只能在这层逐个方法钉死去向。

const SES = 'ses_local'
const HID = 'hitl_abc'

beforeEach(() => {
  localStorage.clear()
  rememberSessionBackend(SES, 'local')
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ id: HID, status: 'ANSWERED' }),
  })) as unknown as typeof fetch)
})

const mock = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock
const urlOf = () => mock().calls[0][0] as string
const bodyOf = () => JSON.parse((mock().calls[0][1] as RequestInit).body as string)

describe('每个方法的去向都钉死在地端', () => {
  it.each([
    ['pending', () => hitlApi.pending(SES), `/api/v1/hitl/pending?session_id=${SES}`],
    ['answer', () => hitlApi.answer(SES, HID, '好'), `/api/v1/hitl/${HID}/answer`],
    ['approve', () => hitlApi.approve(SES, HID), `/api/v1/hitl/${HID}/approve`],
    ['reject', () => hitlApi.reject(SES, HID), `/api/v1/hitl/${HID}/reject`],
    ['reply', () => hitlApi.reply(SES, HID, 'x'), `/api/v1/hitl/${HID}/reply`],
  ])('%s', async (_name, call, want) => {
    await call()
    expect(urlOf()).toBe(want)
  })
})

// 加 sessionId 首参最容易顺手改错的就是这里：把参数挪位后 body 里塞错东西。
describe('请求体不受定址改动影响', () => {
  it('answer 不给 llm 字段时 body 里也不该出现（缺席 = 后端不动会话 LLM）', async () => {
    await hitlApi.answer(SES, HID, '好')
    expect(bodyOf()).toEqual({ answer: '好' })
  })

  it('显式给 llm（含 null）时必须带上', async () => {
    await hitlApi.answer(SES, HID, '好', 'DS', 'deepseek-v4-flash')
    expect(bodyOf()).toEqual({ answer: '好', llm_account: 'DS', llm_model: 'deepseek-v4-flash' })
  })

  it('显式给 account 但没给 model → model 落成 null', async () => {
    await hitlApi.answer(SES, HID, '好', 'DS')
    expect(bodyOf()).toEqual({ answer: '好', llm_account: 'DS', llm_model: null })
  })

  it('reject 带上理由，不给理由时是空串', async () => {
    await hitlApi.reject(SES, HID, '这条命令不能跑')
    expect(bodyOf()).toEqual({ message: '这条命令不能跑' })
    vi.mocked(fetch).mockClear()
    await hitlApi.reject(SES, HID)
    expect(bodyOf()).toEqual({ message: '' })
  })

  it('approve 是空 body', async () => {
    await hitlApi.approve(SES, HID)
    expect(bodyOf()).toEqual({})
  })

  it('reply 带 content', async () => {
    await hitlApi.reply(SES, HID, '补充说明')
    expect(bodyOf()).toEqual({ content: '补充说明' })
  })
})

describe('没记过后端的会话', () => {
  it('一律走本地，不该拼出畸形 URL', async () => {
    await hitlApi.approve('ses_unknown', HID)
    expect(urlOf()).toBe(`/api/v1/hitl/${HID}/approve`)
  })
})
