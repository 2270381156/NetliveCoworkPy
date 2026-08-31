import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LanguageProvider } from '@/i18n'
import { PreviewToolbarProvider, usePreviewToolbar, useTocSidebar } from './PreviewToolbarContext'
import { TocSidebar } from './TocSidebar'

function Registrar({ goto }: { goto: (id: string) => void }) {
  usePreviewToolbar({
    toc: {
      items: [
        { id: 'a', label: 'Intro', level: 0 },
        { id: 'b', label: 'Deep', level: 1 },
      ],
      goto,
    },
  }, [])
  return null
}

function ToggleOn() {
  const { setOpen } = useTocSidebar()
  return <button onClick={() => setOpen(true)}>open</button>
}

function harness(goto: (id: string) => void) {
  return render(
    <LanguageProvider>
      <PreviewToolbarProvider>
        <TocSidebar />
        <ToggleOn />
        <Registrar goto={goto} />
      </PreviewToolbarProvider>
    </LanguageProvider>,
  )
}

describe('TocSidebar', () => {
  it('renders nothing when closed', () => {
    harness(() => {})
    // Sidebar header text shouldn't be present while closed.
    expect(screen.queryByText('Contents')).not.toBeInTheDocument()
  })

  it('renders the outline tree when opened and navigates on click', () => {
    const goto = vi.fn()
    harness(goto)
    act(() => { screen.getByText('open').click() })
    expect(screen.getByText('Contents')).toBeInTheDocument()
    expect(screen.getByText('Intro')).toBeInTheDocument()
    const item = screen.getByText('Deep')
    expect(item).toBeInTheDocument()
    act(() => { item.click() })
    expect(goto).toHaveBeenCalledWith('b')
  })
})
