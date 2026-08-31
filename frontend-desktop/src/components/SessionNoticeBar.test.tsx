import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '@/i18n'
import { SessionNoticeBar } from './SessionNoticeBar'
import type { SessionNotice } from '@/hooks/useSessionSSE'

// LanguageProvider 默认语言取 localStorage → navigator.language；jsdom 测试环境下
// navigator.language 通常是 en-US，与本仓其余组件测试一致（未强制 zh 时断言英文串）。
// 本用例要对齐会话通告的中文文案，故渲染前把语言持久化为 zh（LanguageProvider 启动时读取）。
beforeEach(() => {
  localStorage.setItem('netlive.lang.v1', 'zh')
})

const failedNotice: SessionNotice = {
  kind: 'failed', reason_code: 'TASK_FAILED_BY_THRESHOLD',
  reason_text: '连续 3 次子任务失败，达到熔断阈值（3），会话已终止',
  reason_data: {},
  failures: [
    { title: '抓取页面', reason: '选择器失效' },
    { title: '解析数据', reason: '格式不符' },
    { title: '重试抓取', reason: '选择器仍失效' },
  ],
  created_at: 't1',
}

function renderBar(p: Partial<Parameters<typeof SessionNoticeBar>[0]>) {
  return render(
    <LanguageProvider>
      <SessionNoticeBar
        status="FAILED" notice={failedNotice} interruptReason={null} providers={[]}
        initialProvider="" initialModel=""
        onContinue={() => {}} onResume={() => {}} resumePending={false}
        {...p}
      />
    </LanguageProvider>,
  )
}

describe('SessionNoticeBar', () => {
  it('FAILED: shows reason text, expandable failure list, and fires onContinue', () => {
    const onContinue = vi.fn()
    renderBar({ onContinue })
    expect(screen.getByText(/达到熔断阈值/)).toBeTruthy()
    fireEvent.click(screen.getByText(/查看 3 条失败记录/))
    expect(screen.getByText(/选择器失效/)).toBeTruthy()
    fireEvent.click(screen.getByText('继续对话'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('FAILED with a stale interrupted-kind notice falls back to generic text', () => {
    renderBar({ notice: { ...failedNotice, kind: 'interrupted' } })
    expect(screen.getByText(/未获得可展示的失败原因/)).toBeTruthy()
  })

  it('INTERRUPTED llm_outage uses the LLM-specific hint and fires onResume without body', () => {
    const onResume = vi.fn()
    renderBar({
      status: 'INTERRUPTED', interruptReason: 'llm_outage', onResume,
      notice: { kind: 'interrupted', reason_code: 'llm_outage', reason_text: '', reason_data: {}, failures: [], created_at: 't' },
    })
    expect(screen.getByText(/LLM 服务连接中断/)).toBeTruthy()
    fireEvent.click(screen.getByText('恢复运行'))
    expect(onResume).toHaveBeenCalledWith(undefined)
  })

  it('INTERRUPTED non-overflow (llm_outage): 无钉住模型时触发钮显示后端默认账号的真名', () => {
    const onResume = vi.fn()
    renderBar({
      status: 'INTERRUPTED', interruptReason: 'llm_outage', onResume,
      notice: { kind: 'interrupted', reason_code: 'llm_outage', reason_text: '', reason_data: {}, failures: [], created_at: 't' },
      providers: [{ name: 'acctB', default_model: 'm1', models: [{ name: 'm1' }] }] as never,
    })
    // 换模型恢复对所有中断成因开放，不限 CONTEXT_OVERFLOW。
    // 无钉住模型时**不显示「默认模型」占位**，而是显示后端默认账号（providers 首个 =
    // 种子默认）的真名——支持多个默认账号之后「默认模型」指代不清，真名才明确。
    // 与输入框仍是同源同显示：两边用的是同一个 ModelPickerButton、同一套 label 规则。
    const trigger = screen.getAllByText('m1')[0]
    expect(trigger).toBeTruthy()
    fireEvent.click(trigger)                     // 展开选择器
    const opts = screen.getAllByText('m1')
    fireEvent.click(opts[opts.length - 1])   // 选中列表里那条（本项目编译目标 ES2020，没有 Array.at）
    fireEvent.click(screen.getByText('恢复运行'))
    expect(onResume).toHaveBeenCalledWith({ llm_account: 'acctB', llm_model: 'm1' })
  })

  it('INTERRUPTED CONTEXT_OVERFLOW: picker pre-selects the session current model and can switch', () => {
    const onResume = vi.fn()
    renderBar({
      status: 'INTERRUPTED', interruptReason: 'CONTEXT_OVERFLOW', onResume,
      notice: { kind: 'interrupted', reason_code: 'CONTEXT_OVERFLOW', reason_text: '', reason_data: {}, failures: [], created_at: 't' },
      providers: [{ name: 'acctA', default_model: 'm1', models: [{ name: 'm1' }, { name: 'm2' }] }] as never,
      initialProvider: 'acctA', initialModel: 'm1',
    })
    expect(screen.getByText(/上下文超出模型窗口/)).toBeTruthy()
    // 默认勾选当前模型（触发钮直接显示 m1，用户无需猜"当前"是哪个）
    fireEvent.click(screen.getByText('m1'))
    fireEvent.click(screen.getByText('m2'))
    fireEvent.click(screen.getByText('恢复运行'))
    expect(onResume).toHaveBeenCalledWith({ llm_account: 'acctA', llm_model: 'm2' })
  })
})
