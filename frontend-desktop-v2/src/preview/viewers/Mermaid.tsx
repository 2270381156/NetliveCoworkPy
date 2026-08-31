import { useEffect, useState } from 'react'

// Mermaid is heavy (~500KB) and only needed when a doc actually contains a
// ```mermaid block, so it's dynamically imported on first render — keeps it out
// of the initial bundle and out of unit tests that never render a diagram.
let initialized = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureInit(mermaid: any) {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    // strict = mermaid sanitizes the generated SVG; the chart text comes from a
    // workspace file, so we treat it as untrusted before dangerouslySetInnerHTML.
    securityLevel: 'strict',
    // CRITICAL: without this, a parse error makes mermaid inject its "bomb" error
    // SVG into <body> (not our component) and never remove it — it then sticks to
    // the bottom of the whole app. true → render() rejects instead, hitting our
    // catch so the failure stays inside this component.
    suppressErrorRendering: true,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  })
  initialized = true
}

let seq = 0

/** Render a mermaid diagram source string to inline SVG. */
export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    // Unique id PER render call (not per mount): React StrictMode invokes effects
    // twice in dev, and reusing one id makes mermaid collide on the leftover node.
    const id = `mermaid-${seq++}`
    import('mermaid')
      .then(async (m) => {
        const mermaid = m.default
        ensureInit(mermaid)
        // Validate first (suppressErrors → returns false instead of throwing or
        // touching the DOM) so invalid input never reaches render().
        const ok = await mermaid.parse(chart, { suppressErrors: true })
        if (!ok) throw new Error('图表语法无效')
        const { svg } = await mermaid.render(id, chart)
        if (!cancelled) {
          setSvg(svg)
          setErr('')
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        // Belt-and-suspenders: remove any temp measurement node mermaid may have
        // appended to <body> so nothing leaks into the app frame.
        const orphan = document.getElementById('d' + id) || document.getElementById(id)
        orphan?.parentElement?.removeChild(orphan)
      })
    return () => {
      cancelled = true
    }
  }, [chart])

  if (err) {
    // Fall back to the raw source so a malformed diagram is still readable.
    return (
      <pre className="not-prose" style={{ background: '#fff5f5', color: 'var(--red)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', fontSize: 12, whiteSpace: 'pre-wrap' }}>
        {`Mermaid 渲染失败: ${err}\n\n${chart}`}
      </pre>
    )
  }
  if (!svg) return <div className="not-prose" style={{ color: 'var(--t3)', fontSize: 12, padding: '8px 0' }}>渲染图表中…</div>
  return <div className="not-prose" style={{ display: 'flex', justifyContent: 'center', overflowX: 'auto', margin: '12px 0' }} dangerouslySetInnerHTML={{ __html: svg }} />
}
