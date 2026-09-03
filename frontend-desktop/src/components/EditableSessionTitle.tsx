import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PencilIcon } from 'lucide-react'

import { sessionsApi } from '@/api/sessions'
import type { Session } from '@/types'

export function sessionDisplayTitle(session: Session): string {
  return session.title?.trim() || session.goal || session.user_prompt || session.id.slice(0, 8)
}

export function EditableSessionTitle({
  session,
  className,
  style,
  mode = 'inline',
  trailingActions,
}: {
  session: Session
  className?: string
  style?: React.CSSProperties
  mode?: 'modal' | 'inline'
  trailingActions?: React.ReactNode
}) {
  const qc = useQueryClient()
  const { data: cachedSessions } = useQuery<Session[]>({
    queryKey: ['sessions'],
    queryFn: () => sessionsApi.list(),
    enabled: false,
  })
  const [editing, setEditing] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [scrollDistance, setScrollDistance] = useState(0)
  const [draft, setDraft] = useState('')
  const [savedTitle, setSavedTitle] = useState(session.title || '')
  const saving = useRef(false)
  const cancelBlur = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleViewportRef = useRef<HTMLSpanElement>(null)

  const cachedTitle = cachedSessions?.find(item => item.id === session.id)?.title
  useEffect(
    () => setSavedTitle(cachedTitle ?? session.title ?? ''),
    [session.id, session.title, cachedTitle],
  )
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const visibleTitle = savedTitle.trim() || session.goal || session.user_prompt || session.id.slice(0, 8)

  function begin(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(visibleTitle)
    setEditing(true)
  }

  function cancel() {
    cancelBlur.current = true
    setEditing(false)
  }

  function startHover() {
    setHovered(true)
    const viewport = titleViewportRef.current
    if (!viewport) return
    const distance = viewport.scrollWidth - viewport.clientWidth
    setScrollDistance(Math.max(0, distance))
    setScrolling(distance > 0)
  }

  function stopHover() {
    setHovered(false)
    setScrolling(false)
    setScrollDistance(0)
  }

  async function save() {
    if (saving.current) return
    const title = draft.trim()
    if (!title) {
      setEditing(false)
      return
    }
    if (title === savedTitle.trim()) {
      setEditing(false)
      return
    }
    saving.current = true
    try {
      const updated = await sessionsApi.renameTitle(session.id, title)
      setSavedTitle(updated.title || title)
      qc.setQueryData<Session[]>(['sessions'], old => old?.map(s => (
        s.id === session.id ? { ...s, ...updated, location: s.location } : s
      )))
      setEditing(false)
    } catch {
      // 保留输入值与编辑态，网络恢复后用户可直接再次提交。
      inputRef.current?.focus()
    } finally {
      saving.current = false
    }
  }

  const input = (
    <input
      ref={inputRef}
      value={draft}
      maxLength={200}
      aria-label="修改会话标题"
      placeholder="保持简短且易于识别"
      className={mode === 'inline' ? `min-w-0 flex-1 ${className ?? ''}` : 'w-full text-sm'}
      style={{
        ...style, minWidth: 0, outline: 'none', padding: '4px 7px',
        border: '1px solid var(--blue)', borderRadius: 4,
        background: 'var(--bg1)', color: 'var(--t1)',
      }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onChange={e => setDraft(e.target.value)}
      onBlur={mode === 'inline' ? () => {
        if (cancelBlur.current) { cancelBlur.current = false; return }
        void save()
      } : undefined}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); void save() }
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    />
  )

  const modal = editing && mode === 'modal'
    ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm"
          style={{ background: 'rgba(15,31,61,.35)' }}
          onClick={e => { if (e.target === e.currentTarget) cancel() }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="修改会话标题"
            className="w-[400px] max-w-[90vw] rounded-xl"
            style={{ background: 'var(--bg1)', boxShadow: '0 24px 80px rgba(15,31,61,.22)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 pt-5 text-sm font-semibold" style={{ color: 'var(--t1)' }}>
              修改会话标题
            </div>
            <div className="px-5 pt-3">
              {input}
              <div className="mt-1.5 text-[11px]" style={{ color: 'var(--t3)' }}>
                保持简短且易于识别
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs"
                style={{ border: '1px solid var(--border)', background: 'var(--bg1)', color: 'var(--t2)' }}
                onClick={cancel}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs"
                style={{ border: 0, background: 'var(--blue)', color: '#fff' }}
                onClick={() => { void save() }}
              >
                保存
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div
      className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      onMouseEnter={startHover}
      onMouseLeave={stopHover}
    >
      {editing && mode === 'inline'
        ? input
        : (
            <span
              ref={titleViewportRef}
              className="block min-w-0 overflow-hidden whitespace-nowrap"
              style={{ flex: '1 1 auto', maxWidth: mode === 'modal' ? '100%' : 'calc(100% - 32px)' }}
              title={visibleTitle}
            >
              <span
                className={`inline-block whitespace-nowrap ${className ?? ''}`}
                style={{
                  ...style,
                  animationName: scrolling ? 'session-title-scroll' : undefined,
                  animationDuration: scrolling ? `${Math.max(4, scrollDistance / 35 + 2)}s` : undefined,
                  animationTimingFunction: scrolling ? 'ease-in-out' : undefined,
                  animationIterationCount: scrolling ? 'infinite' : undefined,
                  animationDirection: scrolling ? 'alternate' : undefined,
                  '--session-title-scroll-distance': `-${scrollDistance}px`,
                } as React.CSSProperties}
              >
                {visibleTitle}
              </span>
            </span>
          )}
      {(mode === 'inline' || hovered) && !editing && (
        <div
          data-testid={mode === 'modal' ? 'session-title-actions' : undefined}
          className={mode === 'modal'
            ? 'absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1.5 pl-4'
            : 'flex flex-shrink-0 items-center'}
          style={mode === 'modal'
            ? { zIndex: 1, background: 'linear-gradient(90deg, transparent 0, var(--bg3) 16px)' }
            : undefined}
        >
          <button
            type="button"
            aria-label="修改会话标题"
            title="修改会话标题"
            className={mode === 'inline'
              ? 'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors'
              : 'grid flex-shrink-0 place-items-center'}
            style={{
              padding: mode === 'inline' ? 0 : 1,
              border: 0,
              background: mode === 'inline' ? 'none' : 'transparent',
              color: 'var(--t3)',
              cursor: 'pointer',
            }}
            onClick={begin}
            onMouseEnter={e => {
              e.currentTarget.style.color = mode === 'inline' ? 'var(--t2)' : 'var(--blue)'
              if (mode === 'inline') e.currentTarget.style.background = 'var(--bg3)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'var(--t3)'
              if (mode === 'inline') e.currentTarget.style.background = 'none'
            }}
          >
            <PencilIcon size={mode === 'inline' ? 15 : 13} />
          </button>
          {mode === 'modal' && trailingActions}
        </div>
      )}
      {modal}
    </div>
  )
}
