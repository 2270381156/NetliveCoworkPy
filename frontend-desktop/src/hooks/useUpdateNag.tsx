/**
 * 更新催升级 —— 居中弹窗版。
 *
 * 触发口径：Electron 主进程把更新下好后会推 status='downloaded'。此后每当用户
 * 有「想干活」的动作（进入/切换会话、新建会话、点进输入框、发送/回复），就弹一次
 * 居中升级窗。点「稍后」进入 5 分钟冷却，冷却期内动作不弹，过后下一个动作再弹。
 * 想彻底不弹只能点「立即重启升级」。不挂机弹（无定时器），只跟动作走。
 *
 * 只改 frontend-desktop：不碰主进程，纯粹在前端拿 onUpdateStatus 的既有事件做文章。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { DownloadIcon } from 'lucide-react'
import { useI18n } from '@/i18n'

export const SNOOZE_MS = 5 * 60 * 1000

// poke：任意「用户想干活」的动作里调它，满足条件就弹窗。默认空函数，provider 外调用无副作用。
const NagPokeCtx = createContext<() => void>(() => {})
export const useUpdateNagPoke = () => useContext(NagPokeCtx)

type UpdateState = { status: string; version?: string } | null

export function useUpdateNag() {
  const { t } = useI18n()
  const [update, setUpdate] = useState<UpdateState>(null)
  const [visible, setVisible] = useState(false)
  const snoozeUntil = useRef(0)

  useEffect(() => {
    const applyStatus = (p: { status: string; version?: string }) => {
      setUpdate({ status: p.status, version: p.version })
      // 下好的一刻先弹一次（首轮提醒），之后交给动作触发。
      if (p.status === 'downloaded') setVisible(true)
    }
    const off = window.electronAPI?.onUpdateStatus?.(applyStatus)
    // dev 调试口：dev 模式下主进程不会真发更新事件，暴露一个手动触发器，
    // 在 DevTools 控制台 `__ipmcMockUpdate('downloaded','9.9.9')` 即可复现真实路径。
    // 生产构建（import.meta.env.DEV 为 false）不挂载，绝不泄漏到正式包。
    if (import.meta.env.DEV) {
      ;(window as unknown as { __ipmcMockUpdate?: (status: string, version?: string) => void })
        .__ipmcMockUpdate = (status: string, version = '9.9.9') => applyStatus({ status, version })
    }
    return () => {
      off?.()
      if (import.meta.env.DEV) delete (window as unknown as { __ipmcMockUpdate?: unknown }).__ipmcMockUpdate
    }
  }, [])

  const downloaded = update?.status === 'downloaded'

  // 动作触发入口：只在「已下载」且「不在冷却」时弹。
  const poke = useCallback(() => {
    if (update?.status !== 'downloaded') return
    if (Date.now() < snoozeUntil.current) return
    setVisible(true)
  }, [update?.status])

  const snooze = useCallback(() => {
    snoozeUntil.current = Date.now() + SNOOZE_MS
    setVisible(false)
  }, [])

  const install = useCallback(() => { window.electronAPI?.installUpdate?.() }, [])

  const modalNode = visible && downloaded
    ? <UpdateNagModal version={update?.version} t={t} onInstall={install} onSnooze={snooze} />
    : null

  return { poke, modalNode }
}

/** 把 poke 下发给深层组件（输入框聚焦等）。 */
export function UpdateNagBoundary({ poke, children }: { poke: () => void; children: React.ReactNode }) {
  return <NagPokeCtx.Provider value={poke}>{children}</NagPokeCtx.Provider>
}

function UpdateNagModal({ version, t, onInstall, onSnooze }: {
  version?: string
  t: (k: string, vars?: Record<string, string | number>) => string
  onInstall: () => void
  onSnooze: () => void
}) {
  return (
    // 遮罩：点外面不关（只认按钮），比角落横幅更挡路。
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'msg-fade-up .15s ease both',
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div
        style={{
          width: 360, maxWidth: '90vw', padding: '22px 22px 18px',
          background: 'var(--bg1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r2)', boxShadow: '0 12px 40px rgba(0,0,0,.25)',
          textAlign: 'center',
        }}
      >
        <div style={{
          width: 44, height: 44, margin: '0 auto 12px', borderRadius: '50%',
          background: 'var(--blue-dim)', display: 'grid', placeItems: 'center',
        }}>
          <DownloadIcon size={22} style={{ color: 'var(--blue)' }} />
        </div>
        <p style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, color: 'var(--t1)' }}>
          {t('update.nagTitle')}{version ? ` v${version}` : ''}
        </p>
        <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--t2)' }}>
          {t('update.nagBody')}
        </p>
        <button
          onClick={onInstall}
          style={{
            width: '100%', padding: '9px 0', marginBottom: 8, border: 'none',
            borderRadius: 'var(--r)', background: 'var(--blue)', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('update.nagInstall')}
        </button>
        <button
          onClick={onSnooze}
          style={{
            width: '100%', padding: '7px 0', border: 'none',
            borderRadius: 'var(--r)', background: 'transparent', color: 'var(--t3)',
            fontSize: 12, cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t1)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
        >
          {t('update.nagLater')}
        </button>
      </div>
    </div>
  )
}
