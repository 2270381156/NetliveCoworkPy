import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))
import { ReportSessionButton } from './ReportSessionButton'

describe('ReportSessionButton', () => {
  beforeEach(() => { (window as unknown as { electronAPI?: unknown }).electronAPI = undefined })
  afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI })

  test('opens confirm and calls reportSession with id + note', async () => {
    const reportSession = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession }
    render(<ReportSessionButton sessionId="sess-1" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.change(screen.getByPlaceholderText('chat.reportSessionNote'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    await waitFor(() => expect(reportSession).toHaveBeenCalledWith('sess-1', 'hi'))
  })

  test('closes the dialog right away and uploads in the background', async () => {
    let finish: (v: { ok: boolean }) => void = () => {}
    const reportSession = vi.fn(() => new Promise(res => { finish = res as typeof finish }))
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession }
    render(<ReportSessionButton sessionId="s" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    // 弹窗立刻消失，上传还挂着
    expect(screen.queryByPlaceholderText('chat.reportSessionNote')).toBeNull()
    await waitFor(() => expect(screen.getByText('chat.reportSessionSending')).toBeTruthy())
    finish({ ok: true })
    await waitFor(() => expect(screen.getByText('chat.reportSessionDone')).toBeTruthy())
  })

  test('failure stays put until the user acts on it, and retry re-opens with the note kept', async () => {
    const reportSession = vi.fn().mockResolvedValue({ ok: false, error: 'boom' })
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession }
    render(<ReportSessionButton sessionId="s" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.change(screen.getByPlaceholderText('chat.reportSessionNote'), { target: { value: 'note-1' } })
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    // 统一显示友好文案；原始 error('boom')不出现在界面(记进 electron.log)
    const chip = await screen.findByTitle('chat.reportSessionRetry')
    expect(screen.queryByText('boom')).toBeNull()
    // 点失败条：弹窗带着上次的备注回来
    fireEvent.click(chip)
    expect((screen.getByPlaceholderText('chat.reportSessionNote') as HTMLTextAreaElement).value).toBe('note-1')
    // 中途取消不抹掉"上次没报上去"
    fireEvent.click(screen.getByText('common.cancel'))
    expect(screen.getByTitle('chat.reportSessionRetry')).toBeTruthy()
  })

})
