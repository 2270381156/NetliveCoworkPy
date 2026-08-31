import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '@/i18n'
import { PreviewToolbarProvider, usePreviewToolbar, useTocSidebar } from './PreviewToolbarContext'
import { PreviewToolbar } from './PreviewToolbar'

function Registrar({ toc, search }: {
  toc?: { items: { id: string; label: string; level?: number }[]; goto: (id: string) => void }
  search?: { run: (q: string) => void; next: () => void; prev: () => void; clear: () => void; count?: number }
}) {
  usePreviewToolbar({ ...(toc ? { toc } : {}), ...(search ? { search } : {}) }, [])
  return null
}

function TocStateProbe() {
  const { open } = useTocSidebar()
  return <span data-testid="toc-open">{open ? 'open' : 'closed'}</span>
}

describe('PreviewToolbar TOC button', () => {
  it('toggles the shared tocOpen state when clicked', () => {
    render(
      <LanguageProvider>
        <PreviewToolbarProvider>
          <PreviewToolbar />
          <TocStateProbe />
          <Registrar toc={{ items: [{ id: 'a', label: 'Intro', level: 0 }], goto: () => {} }} />
        </PreviewToolbarProvider>
      </LanguageProvider>,
    )
    expect(screen.getByTestId('toc-open').textContent).toBe('closed')
    const btn = screen.getByTitle('Contents')
    act(() => { btn.click() })
    expect(screen.getByTestId('toc-open').textContent).toBe('open')
    act(() => { btn.click() })
    expect(screen.getByTestId('toc-open').textContent).toBe('closed')
  })
})

describe('PreviewToolbar search input', () => {
  it('Enter triggers next, Shift+Enter triggers prev', () => {
    const next = vi.fn()
    const prev = vi.fn()
    const run = vi.fn()
    render(
      <LanguageProvider>
        <PreviewToolbarProvider>
          <PreviewToolbar />
          <Registrar search={{ run, next, prev, clear: () => {}, count: 0 }} />
        </PreviewToolbarProvider>
      </LanguageProvider>,
    )
    const input = screen.getByPlaceholderText('Search in file…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    expect(run).toHaveBeenCalledWith('foo')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(prev).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(prev).toHaveBeenCalledTimes(1)
  })
})
