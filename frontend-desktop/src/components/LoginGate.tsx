import { useState, useEffect } from 'react'
import type { AuthUser } from '@/types'
import { useI18n } from '@/i18n'
import branding from '@branding'   // 品牌显示名唯一来源，见 electron/branding.json

/**
 * 启动鉴权门：未登录时显示。点「W3 登录」→ 在当前主窗口内覆盖共享 Session 的登录视图，
 * W3 返回工号 → 白名单校验 → IPC 返回用户；主应用页面不卸载并直接进入首页。
 */
export function LoginGate({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [error, setError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  // 正常流程直接接收 login() 的返回值；若认证期间渲染层意外重载，则拉取主进程暂存错误。
  useEffect(() => {
    window.electronAPI?.getLoginError?.().then((err: string | null) => {
      if (err) setError(err)
    }).catch(() => {})
  }, [])

  async function doLogin() {
    if (loggingIn) return
    setError('')
    setLoggingIn(true)
    try {
      const result = await window.electronAPI!.login!()
      if (result && (result as any).__notInWhitelist) {
        setLoggingIn(false)
        setError((result as any).message || (en ? 'You are not in the whitelist' : '用户权限不足，如需开通，请联系：李天宇 00485973'))
        return
      }
      onLogin(result as any)
    } catch (e) {
      setLoggingIn(false)
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg || (en ? 'Authentication failed' : '认证失败'))
    }
  }

  return (
    <div
      className="flex h-screen flex-col items-center justify-center"
      style={{ background: 'var(--bg2)', color: 'var(--t1)', position: 'relative' }}
    >
      {/*
        顶栏拖拽区。两个作用，缺一不可：
        1. titleBarStyle:'hidden' 下窗口顶部默认不可拖动，登录页也该能拖窗口/双击最大化。
        2. Electron 的可拖拽区域是【窗口级】状态：导航到一个完全不声明 app-region 的页面
           时，上一个页面的区域不会被清空。登录页若一处不声明，splash 的拖拽区就会残留下来
           盖住本页，登录按钮点不动、只能拖窗口（PR #127 的真实故障）。显式声明即可刷新。
        尺寸与 App.tsx 顶栏一致：高 36，右侧让出 150px 给 titleBarOverlay 的窗口控件。
      */}
      <div
        style={{
          position: 'absolute', top: 0, left: 0, right: 150, height: 36,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      />
      {loggingIn ? (
        <div
          role="status"
          style={{ color: 'var(--t3)', fontSize: 14, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {en ? 'Opening workspace…' : '正在进入…'}
        </div>
      ) : (
        <div
          className="flex flex-col items-center"
          style={{
            width: 360, padding: '40px 32px', background: 'var(--bg1)',
            border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)',
            // 卡片压在拖拽层之上，且明确不可拖——按钮必须收得到鼠标事件。
            position: 'relative', WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <img src="/icon.svg" alt="" style={{ width: 56, height: 56, marginBottom: 16 }} />
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.5px', marginBottom: 6 }}>
            {branding.productName}
          </div>
          <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 28, textAlign: 'center', lineHeight: 1.6 }}>
            {en ? 'Sign in with W3 to continue' : '请使用 W3 账号登录以继续使用'}
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 14, textAlign: 'center', lineHeight: 1.5, wordBreak: 'break-all' }}>{error}</div>
          )}

          <button
            onClick={doLogin}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
              background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
              transition: 'var(--tr)',
            }}
          >
            {en ? 'Sign in with W3' : 'W3 登录'}
          </button>
        </div>
      )}
    </div>
  )
}
