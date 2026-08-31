import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { BashReviewMode } from '@/api/sessions'

interface Props {
  value: BashReviewMode
  onChange: (mode: BashReviewMode) => void
  disabled?: boolean
}

// 展示顺序（自动化程度递增）：人工审核 → 半自动模式 → 自动模式。
const MODES: BashReviewMode[] = ['manual', 'semiauto', 'strict-auto']
const LABEL_KEY: Record<BashReviewMode, string> = {
  manual: 'chat.workModeManual',
  semiauto: 'chat.workModeSemiauto',
  'strict-auto': 'chat.workModeStrictAuto',
}
const DESC_KEY: Record<BashReviewMode, string> = {
  manual: 'chat.workModeManualDesc',
  semiauto: 'chat.workModeSemiautoDesc',
  'strict-auto': 'chat.workModeStrictAutoDesc',
}

export function WorkModeButton({ value, onChange, disabled }: Props) {
  const { t } = useI18n()
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // top 或 bottom 二选一：输入框在屏幕底部时下方放不下 → 改向上弹（用 bottom 锚定）。
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open) {
      const rect = btnRef.current?.getBoundingClientRect()
      if (rect) {
        const right = window.innerWidth - rect.right
        const EST_H = 220   // 弹窗约高（3 项带描述）；只用于判断朝上还是朝下
        const spaceBelow = window.innerHeight - rect.bottom
        setPos(spaceBelow < EST_H && rect.top > spaceBelow
          ? { bottom: window.innerHeight - rect.top + 6, right }   // 下方不够且上方更宽 → 向上
          : { top: rect.bottom + 6, right })
      }
    }
    setOpen(v => !v)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={disabled}
        title={t('chat.workModeLabel')}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg1)',
          color: 'var(--t2)', fontSize: 12, cursor: disabled ? 'default' : 'pointer',
          outline: 'none', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1,
          transition: 'border-color .15s',
        }}
      >
        <span>{t(LABEL_KEY[value])}</span>
        <ChevronDown size={12} style={{
          flexShrink: 0, color: 'var(--t3)',
          transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none',
        }} />
      </button>

      {open && pos && createPortal(
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', zIndex: 9999, right: pos.right,
            ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
            width: 300, background: '#fff', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: 'var(--shadow2)', padding: 4,
          }}
        >
          {MODES.map(m => {
            const selected = m === value
            return (
              <button
                key={m}
                onClick={() => { onChange(m); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '9px 10px', borderRadius: 7,
                  cursor: 'pointer', border: 'none', textAlign: 'left',
                  background: 'transparent', transition: 'background .1s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <Check size={14} style={{
                  flexShrink: 0,
                  color: 'var(--blue)', visibility: selected ? 'visible' : 'hidden',
                }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: 13,
                    fontWeight: selected ? 600 : 500,
                    color: selected ? 'var(--blue)' : 'var(--t1)',
                  }}>{t(LABEL_KEY[m])}</span>
                  <span style={{
                    display: 'block', fontSize: 11.5, lineHeight: 1.5,
                    color: 'var(--t3)', marginTop: 2,
                  }}>{t(DESC_KEY[m])}</span>
                </span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
