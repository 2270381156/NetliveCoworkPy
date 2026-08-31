import { useState } from 'react'
import type { AuthUser } from '@/types'
import { useI18n } from '@/i18n'

/**
 * 启动鉴权门：未登录时显示。点「登录」→ 调 Electron 主进程打开浏览器走 OAuth，
 * 成功 resolve user 后通知上层切到常规界面。
 */
export function LoginGate({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function doLogin() {
    setError('')
    setLoading(true)
    try {
      const user = await window.electronAPI!.login!()
      onLogin(user)
    } catch (e: any) {
      setError(e?.message ?? (en ? 'Login failed' : '登录失败'))
      setLoading(false)
    }
  }

  return (
    <div
      className="flex h-screen flex-col items-center justify-center"
      style={{ background: 'var(--bg2)', color: 'var(--t1)' }}
    >
      <div
        className="flex flex-col items-center"
        style={{
          width: 320, padding: '40px 32px', background: 'var(--bg1)',
          border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)',
        }}
      >
        <img src="/icon.svg" alt="" style={{ width: 56, height: 56, marginBottom: 16 }} />
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.5px', marginBottom: 6 }}>
          IPMaster-Cowork
        </div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 28, textAlign: 'center', lineHeight: 1.6 }}>
          {loading
            ? (en ? 'Logging in via your browser…' : '正在浏览器中登录…')
            : (en ? 'Sign in to continue' : '请登录以继续使用')}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 14, textAlign: 'center' }}>{error}</div>
        )}

        <button
          onClick={doLogin}
          disabled={loading}
          style={{
            width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
            background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)',
            fontSize: 14, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1, transition: 'var(--tr)',
          }}
        >
          {loading ? (en ? 'Waiting for browser…' : '等待浏览器授权…') : (en ? 'Sign in' : '登录')}
        </button>

        {loading && (
          <button
            onClick={() => { setLoading(false); setError('') }}
            style={{
              marginTop: 10, fontSize: 12, color: 'var(--t3)',
              background: 'none', border: 'none', cursor: 'pointer',
            }}
          >
            {en ? 'Cancel' : '取消'}
          </button>
        )}
      </div>
    </div>
  )
}
