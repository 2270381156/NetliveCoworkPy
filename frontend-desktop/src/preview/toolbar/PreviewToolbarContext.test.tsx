import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useState } from 'react'
import {
  PreviewToolbarProvider, usePreviewToolbar, usePreviewToolbarState,
} from './PreviewToolbarContext'

function Reader() {
  const caps = usePreviewToolbarState()
  return <div data-testid="keys">{Object.keys(caps).sort().join(',')}</div>
}

function Viewer({ scale }: { scale: number }) {
  usePreviewToolbar({ zoom: { in() {}, out() {}, reset() {}, fit() {}, scale } }, [scale])
  return <div>viewer</div>
}

function Harness() {
  const [mounted, setMounted] = useState(true)
  return (
    <PreviewToolbarProvider>
      <Reader />
      {mounted && <Viewer scale={1} />}
      <button onClick={() => setMounted(false)}>unmount</button>
    </PreviewToolbarProvider>
  )
}

describe('PreviewToolbarContext', () => {
  it('exposes registered caps and clears them on viewer unmount', () => {
    render(<Harness />)
    expect(screen.getByTestId('keys').textContent).toBe('zoom')
    act(() => { screen.getByText('unmount').click() })
    expect(screen.getByTestId('keys').textContent).toBe('')
  })
})
