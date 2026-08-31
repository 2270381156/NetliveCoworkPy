import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, XIcon,
  ExternalLinkIcon, GlobeIcon, ZoomInIcon, ZoomOutIcon,
} from 'lucide-react'
import { useI18n } from '@/i18n'
import { setWebviewExtractor, type WebviewContent } from '@/lib/webviewBridge'

/**
 * 应用内浏览器 —— 工作区「网页」tab。
 *
 * 用 Electron <webview> 嵌入网页来源与 MCP 自起的 URL：外部站点常
 * 发 X-Frame-Options 拒绝 iframe，webview 顶层加载不受此限，且活在 DOM 里跟随面板 resize。
 * 安全隔离在 electron/main.js 的 will-attach-webview 里强制（剥 preload、独立 partition）。
 *
 * 关键：webview 必须**始终挂载**（否则地址栏/刷新拿不到 ref），且 loadURL 必须等
 * dom-ready 之后才能调（否则抛 "must be attached ... before this method"）。未 ready 前
 * 的加载请求先入 pendingRef，dom-ready 时补发。
 */

interface WebviewEl extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getURL(): string
  loadURL(url: string): Promise<void>
  setZoomFactor(factor: number): void
  executeJavaScript(code: string): Promise<unknown>
}

// 在 webview 内抓取当前页面：可见正文 + 标题 + 标题层级 + 链接。供 view_side_web_page 工具用。
// 不在前端做长度截断——全量回传，超长由后端 capability gateway 的 spill 机制自动落盘（工具
// spillable=True）。
const EXTRACT_SCRIPT = `(function () {
  var text = document.body ? document.body.innerText : '';
  var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
    .map(function (h) { return (h.innerText || '').trim(); }).filter(Boolean);
  var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
    .map(function (a) { return { text: (a.innerText || '').trim(), href: a.href }; })
    .filter(function (l) { return l.href && l.href.indexOf('javascript:') !== 0; });
  return { title: document.title || '', text: text, headings: headings, links: links };
})()`

const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.1

export function BrowserPanel({ url, onClose }: { url: string | null; onClose?: () => void }) {
  const { t } = useI18n()
  const ref = useRef<WebviewEl | null>(null)
  const readyRef = useRef(false)
  const pendingRef = useRef<string | null>(null)
  const [addr, setAddr] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [hasContent, setHasContent] = useState(false)
  const [loadErr, setLoadErr] = useState<{ code: number; desc: string } | null>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)   // 导航后重新套用缩放（webview 每次加载会重置到 1）

  // 统一加载入口：ready 就直接 loadURL，否则先存起来等 dom-ready 补发。
  function load(raw: string) {
    const u = raw.trim()
    if (!u) return
    setAddr(u)
    if (readyRef.current && ref.current) ref.current.loadURL(u).catch(() => {})
    else pendingRef.current = u
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // webview 每次导航会把缩放重置回 100%，需重新套用。挂在尽量早的时机（导航提交 /
    // DOM 就绪）而非 did-finish-load，否则页面先以 100% 渲染再跳到目标缩放，会闪一下。
    const reapplyZoom = () => { try { el.setZoomFactor(zoomRef.current) } catch { /* 未 attach */ } }
    const onReady = () => {
      readyRef.current = true
      reapplyZoom()
      const p = pendingRef.current
      if (p) { pendingRef.current = null; el.loadURL(p).catch(() => {}) }
    }
    const syncNav = () => {
      reapplyZoom()
      try {
        const u = el.getURL()
        const shown = !u || u === 'about:blank' ? '' : u
        setAddr(shown)
        setCanBack(el.canGoBack())
        setCanFwd(el.canGoForward())
        if (shown) setHasContent(true)
      } catch { /* 尚未 attach */ }
    }
    const onStart = () => { setLoading(true); setLoadErr(null) }
    const onStop = () => { setLoading(false); syncNav() }
    // 加载失败：把真实错误码/描述显示出来（否则只剩空白，无从定位）。
    // 忽略 ERR_ABORTED(-3，正常导航/重定向会触发) 与子框架失败。
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false || ev.errorCode === -3) return
      setLoading(false)
      setLoadErr({ code: ev.errorCode, desc: ev.errorDescription || '' })
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', syncNav)
    el.addEventListener('did-navigate-in-page', syncNav)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', syncNav)
      el.removeEventListener('did-navigate-in-page', syncNav)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [])

  // 调整缩放：立刻套用到当前页并记住，供导航后重套。
  function applyZoom(z: number) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
    zoomRef.current = clamped
    setZoom(clamped)
    try { ref.current?.setZoomFactor(clamped) } catch { /* 未 attach */ }
  }

  // 父组件给了新 url（点了 chat 链接）→ 加载它。
  useEffect(() => { if (url) load(url) }, [url])

  // 把"抓取当前页面"注册到桥，供 view_side_web_page 工具经 SSE round-trip 现取。
  useEffect(() => {
    setWebviewExtractor(async (): Promise<WebviewContent | null> => {
      const el = ref.current
      if (!el || typeof el.executeJavaScript !== 'function') return null
      let u = ''
      try { u = el.getURL() } catch { return null }
      if (!u || u === 'about:blank') return null   // 没开网页
      const data = await el.executeJavaScript(EXTRACT_SCRIPT) as Omit<WebviewContent, 'url'>
      return { url: u, ...data }
    })
    return () => setWebviewExtractor(null)
  }, [])

  function go(raw: string) {
    let u = raw.trim()
    if (!u) return
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u   // 裸域名补协议
    load(u)
  }

  return (
    <div className="flex h-full flex-col text-xs">
      {/* 控制栏 */}
      <div className="flex items-center gap-1 px-2 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <IconBtn title={t('browser.back')} disabled={!canBack} onClick={() => ref.current?.goBack()}>
          <ArrowLeftIcon size={14} />
        </IconBtn>
        <IconBtn title={t('browser.forward')} disabled={!canFwd} onClick={() => ref.current?.goForward()}>
          <ArrowRightIcon size={14} />
        </IconBtn>
        <IconBtn title={loading ? t('browser.stop') : t('browser.reload')} onClick={() => { if (loading) ref.current?.stop(); else if (addr) go(addr) }}>
          {loading ? <XIcon size={14} /> : <RotateCwIcon size={13} />}
        </IconBtn>
        <input
          value={addr}
          onChange={e => setAddr(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(addr) }}
          placeholder={t('browser.addressPlaceholder')}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: 26, padding: '0 10px', borderRadius: 'var(--r)',
            border: '1px solid var(--border)', background: 'var(--bg1)', color: 'var(--t1)',
            outline: 'none', fontSize: 12,
          }}
        />
        <IconBtn title={t('browser.zoomOut')} disabled={zoom <= ZOOM_MIN} onClick={() => applyZoom(zoom - ZOOM_STEP)}>
          <ZoomOutIcon size={13} />
        </IconBtn>
        <button
          title={t('browser.zoomReset')}
          onClick={() => applyZoom(1)}
          style={{
            minWidth: 34, height: 24, padding: '0 4px', flexShrink: 0, fontSize: 11,
            color: 'var(--t3)', background: 'none', border: 'none',
            cursor: zoom === 1 ? 'default' : 'pointer', fontVariantNumeric: 'tabular-nums',
          }}
        >{Math.round(zoom * 100)}%</button>
        <IconBtn title={t('browser.zoomIn')} disabled={zoom >= ZOOM_MAX} onClick={() => applyZoom(zoom + ZOOM_STEP)}>
          <ZoomInIcon size={13} />
        </IconBtn>
        {addr && (
          <IconBtn title={t('browser.openExternal')} onClick={() => window.electronAPI?.openExternal?.(addr)}>
            <ExternalLinkIcon size={13} />
          </IconBtn>
        )}
        {onClose && (
          <IconBtn title={t('browser.close')} onClick={onClose}>
            <XIcon size={14} />
          </IconBtn>
        )}
      </div>

      {/* 内容区：webview 始终挂载；无内容时叠一层提示。 */}
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        <webview
          ref={ref as unknown as React.Ref<HTMLElement>}
          src="about:blank"
          partition="persist:inappbrowser"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        {!hasContent && !loadErr && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{ background: 'var(--bg1)', pointerEvents: 'none' }}
          >
            <GlobeIcon size={30} style={{ color: 'var(--t3)', opacity: .5 }} />
            <p style={{ color: 'var(--t3)' }}>{t('browser.empty')}</p>
          </div>
        )}
        {loadErr && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center"
            style={{ background: 'var(--bg1)' }}
          >
            <GlobeIcon size={30} style={{ color: 'var(--red)', opacity: .6 }} />
            <p style={{ color: 'var(--t1)', fontWeight: 600 }}>{t('browser.loadFailed')}</p>
            <p style={{ color: 'var(--t3)', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
              {loadErr.desc} ({loadErr.code})
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => go(addr)}
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 'var(--r)', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--t2)', cursor: 'pointer' }}
              >{t('browser.reload')}</button>
              <button
                onClick={() => window.electronAPI?.openExternal?.(addr)}
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 'var(--r)', border: 'none', background: 'var(--blue)', color: '#fff', cursor: 'pointer' }}
              >{t('browser.openExternal')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({ onClick, title, disabled, children }: {
  onClick: () => void; title?: string; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors"
      style={{
        color: disabled ? 'var(--t4, #cbd5e1)' : 'var(--t3)',
        background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={e => { if (!disabled) { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' } }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = disabled ? 'var(--t4, #cbd5e1)' : 'var(--t3)' }}
    >
      {children}
    </button>
  )
}
