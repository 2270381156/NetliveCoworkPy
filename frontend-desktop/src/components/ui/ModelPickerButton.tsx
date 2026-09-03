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

// 弹层定位常量：GAP 是与触发按钮的间距；MIN_POPUP_H 是「下方空间小于它就翻到上方」的阈值
//（比一两行高，够放三四个选项才算装得下）；MAX_POPUP_H 是不受空间限制时的上限。
const GAP = 4
const MARGIN = 8          // 与视口边缘留的余量，别贴边
const MIN_POPUP_H = 140
const MAX_POPUP_H = 240

export function ModelPickerButton({
  providers, selectedProvider, selectedModel, onChange,
  disabled, variant = 'pill', placeholder,
}: Props) {
  const { t } = useI18n()
  const ph = placeholder ?? t('chat.defaultModel')
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number; maxHeight?: number } | null>(null)

  const label = useMemo(() => {
    // ⚠ 所选账号必须**当前还在** providers 里才显示它。后端一个 llm 都没有（或用户把那个
    //    账号删了）时，selectedProvider 可能是 localStorage 残留的旧名——不校验就会一直
    //    亮着一个已经不存在的模型。存在才用它，否则回落默认账号 / 占位。
    if (selectedProvider && providers.some(p => p.name === selectedProvider)) {
      return selectedModel || selectedProvider
    }
    // 未显式选择（或所选已不存在）：显示后端默认账号（列表首个 = 种子默认）的真名。
    // providers 为空（后端没加载任何 llm）→ null → 外层显示占位，不残留旧模型。
    const def = providers[0]
    return def ? (def.default_model || def.name) : null
  }, [selectedProvider, selectedModel, providers])

  const options = useMemo(() => {
    // 默认账号已作为真名账号列出、可直接选，不再需要空的「默认模型」占位项。
    const list: { provider: string; model: string }[] = []
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
          // 默认向下弹；下方装不下就翻到上方——这个选择器常常落在对话框靠底部的位置，
          // 一律向下的话弹层被视口下边缘压成一条缝（只露出一两行，看着像没渲染出来）。
          // maxHeight 同时按该侧的实际可用空间夹一次，避免翻上去之后又被顶边缘截断。
          const below = window.innerHeight - rect.bottom - MARGIN
          const above = rect.top - MARGIN
          const flipUp = below < MIN_POPUP_H && above > below
          setPos(flipUp
            ? {
                bottom: window.innerHeight - rect.top + GAP,
                left: rect.left,
                right: window.innerWidth - rect.right,
                maxHeight: Math.min(MAX_POPUP_H, above - GAP),
              }
            : {
                top: rect.bottom + GAP,
                left: rect.left,
                right: window.innerWidth - rect.right,
                maxHeight: Math.min(MAX_POPUP_H, below - GAP),
              })
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
            maxWidth: 300, maxHeight: pos.maxHeight ?? MAX_POPUP_H, overflowY: 'auto',
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
