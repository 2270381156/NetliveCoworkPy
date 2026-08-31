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

  test('shows the error when reportSession returns ok:false', async () => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) }
    render(<ReportSessionButton sessionId="s" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })
})
