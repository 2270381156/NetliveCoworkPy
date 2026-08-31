import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, Check } from 'lucide-react'
import type { LLMProvider } from '@/types'
import { useI18n } from '@/i18n'

interface Props {
  providers: LLMProvider[]
  selectedProvider: string
  selectedModel: string
  onChange: (provider: string, model: string) => void
  disabled?: boolean
  /** 'pill' = compact pill button (chat input); 'field' = full-width form field style */
  variant?: 'pill' | 'field'
  placeholder?: string
}

export function ModelPickerButton({
  providers, selectedProvider, selectedModel, onChange,
  disabled, variant = 'pill', placeholder,
}: Props) {
  const { t } = useI18n()
  const ph = placeholder ?? t('chat.defaultModel')
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null)

  const label = useMemo(() => {
    if (!selectedProvider) return null
    if (!selectedModel) return selectedProvider
    return selectedModel
  }, [selectedProvider, selectedModel])

  const options = useMemo(() => {
    const list: { provider: string; model: string }[] = [{ provider: '', model: '' }]
    for (const p of providers) {
      if (p.models.length === 0) {
        list.push({ provider: p.name, model: '' })
      } else {
        for (const m of p.models) {
          list.push({ provider: p.name, model: m.name })
        }
      }
    }
    return list
  }, [providers])

  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open) {
      const rect = btnRef.current?.getBoundingClientRect()
      if (rect) {
        if (variant === 'field') {
          // dropdown opens below the trigger
          setPos({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right })
        } else {
          setPos({ bottom: window.innerHeight - rect.top + 6, right: window.innerWidth - rect.right })
        }
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

  const chevronStyle: React.CSSProperties = {
    flexShrink: 0, color: 'var(--t3)',
    transition: 'transform .15s',
    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
  }

  const triggerStyle: React.CSSProperties = variant === 'field' ? {
    display: 'flex', alignItems: 'center', gap: 6,
    width: '100%', height: 32, padding: '0 10px',
    borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg2)', color: label ? 'var(--t1)' : 'var(--t3)',
    fontSize: 14, cursor: 'pointer', outline: 'none',
    transition: 'border-color .15s',
    opacity: disabled ? 0.45 : 1,
  } : {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 10px', borderRadius: 20,
    border: '1px solid var(--border)', background: 'var(--bg2)',
    color: 'var(--t2)', fontSize: 11.5, cursor: 'pointer',
    outline: 'none', maxWidth: 180, whiteSpace: 'nowrap',
    transition: 'background var(--tr), border-color var(--tr)',
    opacity: disabled ? 0.45 : 1,
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={disabled}
        style={triggerStyle}
        onMouseEnter={e => {
          if (disabled) return
          const el = e.currentTarget as HTMLElement
          if (variant === 'field') el.style.borderColor = 'var(--blue)'
          else { el.style.background = 'var(--bg3)'; el.style.borderColor = 'var(--border2)' }
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement
          if (variant === 'field') el.style.borderColor = 'var(--border)'
          else { el.style.background = 'var(--bg2)'; el.style.borderColor = 'var(--border)' }
        }}
      >
        {variant === 'field' && label && selectedProvider && (
          <span style={{
            fontSize: 11, flexShrink: 0, padding: '1px 6px', borderRadius: 4,
            background: 'var(--blue-dim)', color: 'var(--blue)',
          }}>{selectedProvider}</span>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
          {label ?? ph}
        </span>
        <ChevronUp size={variant === 'field' ? 12 : 10} style={chevronStyle} />
      </button>

      {open && pos && createPortal(
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', zIndex: 9999,
            ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
            ...(pos.left !== undefined ? { left: pos.left } : {}),
            ...(pos.right !== undefined ? { right: pos.right } : {}),
            minWidth: variant === 'field' ? (btnRef.current?.offsetWidth ?? 200) : 200,
            maxWidth: 300, maxHeight: 240, overflowY: 'auto',
            background: '#fff', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: 'var(--shadow2)', padding: 4,
          }}
        >
          {options.map((opt, i) => {
            const selected = opt.provider === selectedProvider && opt.model === selectedModel
            return (
              <button
                key={i}
                onClick={() => { onChange(opt.provider, opt.model); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', padding: '7px 10px', borderRadius: 7,
                  cursor: 'pointer', border: 'none', textAlign: 'left',
                  background: 'transparent', transition: 'background .1s',
                  color: selected ? 'var(--blue)' : 'var(--t1)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                {opt.provider && (
                  <span style={{
                    fontSize: 11, flexShrink: 0, padding: '1px 6px', borderRadius: 4,
                    background: selected ? 'rgba(37,99,235,.1)' : 'var(--bg2)',
                    color: selected ? 'var(--blue)' : 'var(--t3)',
                  }}>{opt.provider}</span>
                )}
                <span style={{
                  fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', fontWeight: selected ? 500 : 400,
                }}>
                  {opt.model || (opt.provider ? opt.provider : ph)}
                </span>
                {selected && <Check size={11} style={{ flexShrink: 0, color: 'var(--blue)' }} />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
