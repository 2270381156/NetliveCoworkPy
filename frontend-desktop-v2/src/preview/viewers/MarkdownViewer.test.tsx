import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '@/i18n'
import { PreviewToolbarProvider } from '../toolbar/PreviewToolbarContext'

// Stub the network-backed file loader so the viewer renders synchronously with a
// fixed markdown body containing one external and one in-workspace link.
vi.mock('./common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./common')>()
  return {
    ...actual,
    useFileText: () => ({
      content: '[ext](https://example.com)\n\n[doc](./other.md)\n\n[missing](missing.md)\n',
      error: null,
    }),
  }
})

import { MarkdownViewer } from './MarkdownViewer'

const MD_PATH = 'C:\\ws\\docs\\index.md'

function harness(onNavigate?: (p: string) => void) {
  return render(
    <LanguageProvider>
      <PreviewToolbarProvider>
        <MarkdownViewer path={MD_PATH} filename="index.md" onNavigate={onNavigate} />
      </PreviewToolbarProvider>
    </LanguageProvider>,
  )
}

describe('MarkdownViewer links', () => {
  it('renders external links as new-window targets (OS browser via Electron)', () => {
    harness()
    const a = screen.getByText('ext').closest('a')!
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noreferrer')
  })

  it('opens an in-workspace doc link in the preview panel instead of navigating', () => {
    const onNavigate = vi.fn()
    harness(onNavigate)
    const a = screen.getByText('doc').closest('a')!
    // Not a new-window link — handled in-app.
    expect(a.getAttribute('target')).toBeNull()
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    // Resolved against the markdown file's own directory.
    expect(onNavigate).toHaveBeenCalledWith('C:/ws/docs/other.md')
    // Default navigation suppressed → main frame never leaves the SPA.
    expect(ev.defaultPrevented).toBe(true)
  })

  it('swallows in-workspace links (preventDefault) even without an onNavigate handler', () => {
    harness(undefined)
    const a = screen.getByText('missing').closest('a')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
