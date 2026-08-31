import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp, Square, Brain, Terminal, FolderIcon,
  Copy, Check, PanelRightIcon, PanelRightCloseIcon,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SSEHandle, ChatItem, ChatMessage, ChatToolCall, ChatWaitingInput, ChatObserverMessage, ChatTaskSummary, ChatImageData, AskQuestion } from '@/hooks/useSessionSSE'
import { sessionsApi, type MessageContent } from '@/api/sessions'
import { llmsApi } from '@/api/llms'
import type { PendingSession } from '@/types'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ModelPickerButton } from '@/components/ui/ModelPickerButton'
import { LLMErrorModal } from '@/components/LLMErrorModal'
import { ReportSessionButton } from '@/components/ReportSessionButton'
import { activityLabel, formatDuration } from '@/lib/activity'
import type { ActivityState } from '@/lib/activity'
import { useI18n } from '@/i18n'

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

// ── Copy button — icon only, hidden until row hover, tooltip on button hover ──

function CopyButton({ text, alignEnd }: { text: string; alignEnd?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  async function doCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={doCopy}
      className="copy-btn"
      style={{
        position: 'relative',
        marginTop: 4, padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
        border: `1px solid ${copied ? 'var(--teal)' : 'var(--border)'}`,
        background: copied ? 'rgba(8,145,178,.08)' : 'var(--bg2)',
        color: copied ? 'var(--teal)' : 'var(--t3)',
        display: 'inline-flex', alignItems: 'center',
        alignSelf: alignEnd ? 'flex-end' : 'flex-start',
        transition: 'color var(--tr), background var(--tr), border-color var(--tr)',
      }}
      onMouseEnter={e => {
        const btn = e.currentTarget as HTMLElement
        if (!copied) { btn.style.background = 'var(--bg3)'; btn.style.borderColor = 'var(--border2)'; btn.style.color = 'var(--t2)' }
        const tip = btn.querySelector('.copy-tip') as HTMLElement | null
        if (tip) tip.style.opacity = '1'
      }}
      onMouseLeave={e => {
        const btn = e.currentTarget as HTMLElement
        if (!copied) { btn.style.background = 'var(--bg2)'; btn.style.borderColor = 'var(--border)'; btn.style.color = 'var(--t3)' }
        const tip = btn.querySelector('.copy-tip') as HTMLElement | null
        if (tip) tip.style.opacity = '0'
      }}
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
      {/* Tooltip */}
      <span className="copy-tip" style={{
        position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(15,23,42,.85)', color: '#fff',
        fontSize: 11, padding: '3px 7px', borderRadius: 4,
        whiteSpace: 'nowrap', pointerEvents: 'none',
        opacity: 0, transition: 'opacity .15s',
      }}>
        {copied ? t('chat.copied') : t('chat.copy')}
      </span>
    </button>
  )
}

interface Props {
  sessionId: string | null
  sse: SSEHandle
  pendingSession: PendingSession | null
  onSessionCreated: (id: string) => void
  nextProvider: string
  nextModel: string
  onNextLLMChange: (provider: string, model: string) => void
  canShowWorkspace?: boolean
  workspaceOpen?: boolean
  onToggleWorkspace?: () => void
}

export function ChatPanel({ sessionId, sse, pendingSession, onSessionCreated, nextProvider, nextModel, onNextLLMChange, canShowWorkspace, workspaceOpen, onToggleWorkspace }: Props) {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [images, setImages] = useState<{ data: string; media_type: string }[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { data: providers = [], isSuccess: providersLoaded } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })

  const session = sse.session
  const isRunning = session?.status === 'RUNNING' || session?.status === 'QUEUED'
  const isWaiting = session?.status === 'WAITING_INPUT' || session?.status === 'PAUSED_HITL'
  const isInterrupted = session?.status === 'INTERRUPTED'

  useEffect(() => {
    // 只采纳"可见账号"：env 默认账号对用户隐藏（不在 providers 列表里），
    // 此时不显示它的真实名字（如 deepseek-rj），让选择器回落到"默认模型"。
    if (session?.llm_account && providers.some(p => p.name === session.llm_account)) {
      onNextLLMChange(session.llm_account, session.llm_model ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, providers])

  useEffect(() => {
    // 选中的账号已不存在（被删除/隐藏）→ 选择框清回"默认模型"。
    // 仅在 providers 已成功加载后判断，避免加载中误清；providers 为空也算已加载。
    if (providersLoaded && nextProvider && !providers.some(p => p.name === nextProvider)) {
      onNextLLMChange('', '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, nextProvider, providersLoaded])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sse.items, sse.streamingText, sse.observerStreamingText, autoScroll])

  const handleScroll = useCallback(() => {
    if (!listRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 80)
  }, [])

  // Create session on first message (pending mode)
  const createMut = useMutation({
    mutationFn: (content: { text: string; imgs: typeof images }) => {
      const { text } = content
      const userPrompt = text
      return sessionsApi.create({
        user_prompt: userPrompt,
        llm_account: pendingSession?.provider || null,
        llm_model: pendingSession?.model || null,
        workspace: pendingSession?.workingDir || null,
      })
    },
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      setInput('')
      setImages([])
      onSessionCreated(session.id)
    },
  })

  const sendMut = useMutation({
    mutationFn: (content: MessageContent) => sessionsApi.sendMessage(sessionId!, content, nextProvider || null, nextModel || null),
    // 向已结束会话发消息会使其恢复运行；该会话的事件流在终态时已被关闭，需重新订阅
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); setInput(''); setImages([]); sse.reconnect() },
  })
  const answerMut = useMutation({
    mutationFn: (text: string) => sessionsApi.answerInput(sessionId!, text),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); setInput('') },
  })
  const interruptMut = useMutation({ mutationFn: () => sessionsApi.interrupt(sessionId!) })
  const resumeMut = useMutation({
    mutationFn: () => sessionsApi.resume(sessionId!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); sse.clearLlmError(); sse.reconnect() },
  })

  const bashModeQ = useQuery({
    queryKey: ['bash-review-mode', sessionId],
    queryFn: () => sessionsApi.getBashReviewMode(sessionId!),
    enabled: !!sessionId,
  })
  const bashModeMut = useMutation({
    mutationFn: (mode: 'auto' | 'manual') => sessionsApi.setBashReviewMode(sessionId!, mode),
    onSuccess: (d) => qc.setQueryData(['bash-review-mode', sessionId], d),
  })
  const bashMode = bashModeQ.data?.mode ?? 'auto'

  function send() {
    const text = input.trim()
    if (!text && images.length === 0) return

    // Pending mode: first message triggers session creation
    if (pendingSession) {
      createMut.mutate({ text, imgs: images })
      return
    }

    if (!sessionId) return

    if (isWaiting && sse.waitingInput) {
      answerMut.mutate(text)
      return
    }

    const content: MessageContent = images.length > 0
      ? [
          ...images.map(img => ({ type: 'image' as const, data: img.data, media_type: img.media_type, source_type: 'base64' as const })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text
    sendMut.mutate(content)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function pasteImage(e: React.ClipboardEvent) {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = ev => {
          const dataUrl = ev.target?.result as string
          const base64 = dataUrl.split(',')[1]
          if (base64) setImages(imgs => [...imgs, { data: base64, media_type: item.type }])
        }
        reader.readAsDataURL(file)
      }
    }
  }

  // ── Pending mode ──────────────────────────────────────────────────────────────

  if (pendingSession) {
    const dirName = pendingSession.workingDir.split(/[\\/]/).filter(Boolean).pop() ?? pendingSession.workingDir
    const isCreating = createMut.isPending
    const canSend = !isCreating && (input.trim().length > 0 || images.length > 0)

    return (
      <div className="flex h-full flex-col" style={{ background: 'var(--bg1)' }}>
        {/* Header —— 透明，继承父级 bg1 白底 */}
        <div className="flex items-center gap-2 px-4 py-2">
          <FolderIcon size={14} className="flex-shrink-0 text-yellow-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" style={{ color: 'var(--t1)' }}>{dirName}</p>
            <p className="truncate text-xs" style={{ color: 'var(--t3)' }}>{pendingSession.workingDir}</p>
          </div>
        </div>

        {/* Empty area */}
        <div className="flex flex-1 flex-col items-center justify-center gap-3" style={{ color: 'var(--t3)' }}>
          <div style={{ fontSize: 32, opacity: .35 }}>💬</div>
          <p className="text-sm">{t('chat.startAgentHint')}</p>
        </div>

        {/* Input —— 透明背景，跟 chat 区一体 */}
        <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
          <div style={{
            background: 'var(--bg1)', border: '1px solid var(--border)',
            borderRadius: 'var(--r2)', boxShadow: 'var(--shadow)',
            transition: 'border-color .15s, box-shadow .15s',
          }}
            onFocusCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
            onBlurCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow)' }}
          >
            {images.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 11px 0' }}>
                {images.map((img, i) => (
                  <div key={i} className="group" style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
                    <img src={`data:${img.media_type};base64,${img.data}`} style={{ width: '100%', height: '100%', borderRadius: 6, objectFit: 'cover' }} />
                    <button onClick={() => setImages(imgs => imgs.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: '50%', background: '#94a3b8', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer' }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              autoFocus
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px` }}
              onKeyDown={onKeyDown}
              onPaste={pasteImage}
              disabled={isCreating}
              placeholder={t('chat.firstInputPlaceholder')}
              rows={1}
              style={{
                width: '100%', padding: '11px 13px 4px', margin: 0,
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13.5,
                resize: 'none', maxHeight: 160, lineHeight: 1.6,
                opacity: isCreating ? 0.4 : 1,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px 8px' }}>
              <span style={{ flex: 1 }} />
              <ModelPickerButton
                providers={providers}
                selectedProvider={pendingSession.provider}
                selectedModel={pendingSession.model}
                onChange={onNextLLMChange}
                disabled={isCreating}
              />
              <button
                onClick={send}
                disabled={!canSend}
                style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  background: canSend ? 'var(--blue)' : 'var(--bg3)',
                  border: 'none', color: canSend ? '#fff' : 'var(--t3)',
                  display: 'grid', placeItems: 'center', cursor: canSend ? 'pointer' : 'not-allowed',
                  transition: 'background var(--tr)',
                }}
              >
                {isCreating ? <Spinner className="h-3 w-3" /> : <ArrowUp size={14} strokeWidth={2.5} />}
              </button>
            </div>
          </div>
          {createMut.isError && (
            <p style={{ marginTop: 4, fontSize: 11, color: 'var(--red)' }}>{(createMut.error as Error)?.message}</p>
          )}
        </div>
      </div>
    )
  }

  // ── No session selected ───────────────────────────────────────────────────────

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: 'var(--t3)', background: 'var(--bg0)' }}>
        <div style={{ fontSize: 36, opacity: .35 }}>💬</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t2)' }}>{t('chat.startConversation')}</div>
        <p className="text-sm">{t('chat.selectOrCreate')}</p>
      </div>
    )
  }

  // ── Normal session mode ───────────────────────────────────────────────────────

  const canSend = !isRunning && (input.trim().length > 0 || images.length > 0)
  const waitingItem = sse.waitingInput

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg1)' }}>
      {/* Header —— 透明，跟 chat 一体 */}
      {session && (
        <div className="flex items-center justify-between px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" style={{ color: 'var(--t1)' }}>
              {session.goal || session.user_prompt || session.id.slice(0, 8)}
            </p>
          </div>
          <div className="ml-3 flex flex-shrink-0 items-center gap-1">
            <label className="mr-1 flex items-center gap-1.5 text-xs" style={{ color: 'var(--t3)' }}>
              <span>{t('chat.workModeLabel')}</span>
              <select
                value={bashMode}
                onChange={e => bashModeMut.mutate(e.target.value as 'auto' | 'manual')}
                disabled={bashModeMut.isPending}
                title={t('chat.workModeLabel')}
                style={{
                  fontSize: 12, color: 'var(--t2)', background: 'var(--bg1)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  padding: '2px 6px', cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="auto">{t('chat.workModeAuto')}</option>
                <option value="manual">{t('chat.workModeManual')}</option>
              </select>
            </label>
            <ReportSessionButton sessionId={session.id} />
            {canShowWorkspace && onToggleWorkspace && (
              <HeaderIconBtn
                title={workspaceOpen ? t('chat.hideWorkspace') : t('chat.showWorkspace')}
                active={workspaceOpen}
                onClick={onToggleWorkspace}
              >
                {workspaceOpen ? <PanelRightCloseIcon size={15} /> : <PanelRightIcon size={15} />}
              </HeaderIconBtn>
            )}
          </div>
        </div>
      )}

      {/* Messages —— 透明，跟父级一体 */}
      <div ref={listRef} onScroll={handleScroll} className="flex-1 overflow-y-auto" style={{ paddingTop: 12, paddingBottom: 8 }}>
        {!sse.connected && !sse.session && (
          <div className="flex justify-center py-4"><Spinner /></div>
        )}

        {sse.items.map(item => <ChatItemView key={item.id} item={item} />)}

        {/* Streaming text */}
        {(sse.streamingText !== null || sse.streamingImages.length > 0 || sse.streamingReasoning !== null) && (
          <AssistantBubble content={sse.streamingText ?? ''} images={sse.streamingImages} reasoning={sse.streamingReasoning ?? undefined} streaming />
        )}

        {/* Observer streaming */}
        {sse.observerStreamingText !== null && (
          <div style={{ padding: '4px 16px 4px 58px', fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>
            {sse.observerStreamingText}
          </div>
        )}

        {/* Waiting input */}
        {waitingItem && (
          <div style={{ padding: '4px 16px' }}>
            <WaitingInputPanel
              item={waitingItem}
              input={input}
              setInput={setInput}
              onSubmit={send}
              onAnswer={(t) => answerMut.mutate(t)}
              onApprove={() => answerMut.mutate('approved')}
              onReject={() => answerMut.mutate('rejected')}
            />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* LLM 可重试失败的内联提示 —— 信息性,无按钮(终态失败走弹窗) */}
      {sse.llmRetrying && (
        <div style={{ padding: '0 14px 6px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            borderRadius: 'var(--r)', border: '1px solid rgba(220,38,38,.25)', background: 'rgba(254,242,242,.7)',
          }}>
            <Spinner className="h-3 w-3" />
            <span style={{ fontSize: 12.5, color: '#b91c1c' }}>
              {sse.llmRetryProgress
                ? t('llmError.retryingN', { attempt: sse.llmRetryProgress.attempt, max: sse.llmRetryProgress.maxAttempts })
                : t('llmError.retrying')}
            </span>
          </div>
        </div>
      )}

      {/* Activity strip —— 输入框上方，显示当前在干嘛 + 时长 */}
      {!waitingItem && !isInterrupted && (
        <div style={{ padding: '0 18px', flexShrink: 0 }}>
          <ActivityStrip activity={sse.currentActivity} />
        </div>
      )}

      {/* INTERRUPTED —— 续跑(事件重放),不接受新文本,故取代输入框。
          LLM 故障中断(interrupt_reason=llm_outage)用红色调 + 专属文案,与通用中断(重启等)区分。 */}
      {!waitingItem && isInterrupted && (() => {
        const isLlmOutage = sse.interruptReason === 'llm_outage'
        return (
          <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              borderRadius: 'var(--r)',
              border: `1px solid ${isLlmOutage ? 'rgba(220,38,38,.3)' : 'rgba(138,163,191,.3)'}`,
              background: isLlmOutage ? 'rgba(254,242,242,.7)' : 'rgba(234,240,251,.5)',
            }}>
              <span style={{ flex: 1, fontSize: 12.5, color: isLlmOutage ? '#b91c1c' : 'var(--t2)' }}>
                {isLlmOutage ? t('llmError.interrupted') : t('chat.interruptedHint')}
              </span>
              <Button size="sm" disabled={resumeMut.isPending} onClick={() => resumeMut.mutate()}>
                {resumeMut.isPending ? <Spinner className="h-3 w-3" /> : t('chat.resume')}
              </Button>
            </div>
          </div>
        )
      })()}

      {/* Input —— 透明背景，跟 chat 一体 */}
      {!waitingItem && !isInterrupted && (
        <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
          <div style={{
            background: 'var(--bg1)', border: '1px solid var(--border)',
            borderRadius: 'var(--r2)', boxShadow: 'var(--shadow)',
            transition: 'border-color .15s, box-shadow .15s',
          }}
            onFocusCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
            onBlurCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow)' }}
          >
            {images.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 11px 0' }}>
                {images.map((img, i) => (
                  <div key={i} style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
                    <img src={`data:${img.media_type};base64,${img.data}`} style={{ width: '100%', height: '100%', borderRadius: 6, objectFit: 'cover' }} />
                    <button onClick={() => setImages(imgs => imgs.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: '50%', background: '#94a3b8', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer' }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px` }}
              onKeyDown={onKeyDown}
              onPaste={pasteImage}
              disabled={isRunning}
              placeholder={isRunning ? t('chat.waitingResponse') : t('chat.inputPlaceholder')}
              rows={1}
              style={{
                width: '100%', padding: '11px 13px 4px', margin: 0,
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13.5,
                resize: 'none', maxHeight: 160, lineHeight: 1.6,
                opacity: isRunning ? 0.5 : 1,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px 8px' }}>
              <span style={{ flex: 1 }} />
              <ModelPickerButton
                providers={providers}
                selectedProvider={nextProvider}
                selectedModel={nextModel}
                onChange={onNextLLMChange}
                disabled={isRunning}
              />
              {isRunning ? (
                <button
                  onClick={() => interruptMut.mutate()}
                  style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: '#ef4444', border: 'none', color: '#fff',
                    display: 'grid', placeItems: 'center', cursor: 'pointer',
                    transition: 'background var(--tr)',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#dc2626' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#ef4444' }}
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!canSend}
                  style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: canSend ? 'var(--blue)' : 'var(--bg3)',
                    border: 'none', color: canSend ? '#fff' : 'var(--t3)',
                    display: 'grid', placeItems: 'center', cursor: canSend ? 'pointer' : 'not-allowed',
                    transition: 'background var(--tr)',
                  }}
                >
                  {sendMut.isPending ? <Spinner className="h-3 w-3" /> : <ArrowUp size={14} strokeWidth={2.5} />}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 终态 LLM 调用错误弹窗 */}
      {sse.llmError && (
        <LLMErrorModal
          message={sse.llmError.message}
          onClose={sse.clearLlmError}
        />
      )}
    </div>
  )
}

// ── Header icon button ────────────────────────────────────────────────────────

function HeaderIconBtn({ onClick, title, active, children }: {
  onClick: () => void; title?: string; active?: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      style={{
        background: active ? 'var(--blue-dim)' : 'none',
        color: active ? 'var(--blue)' : 'var(--t3)',
        border: 'none', cursor: 'pointer',
      }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; if (!active) { el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' } }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; if (!active) { el.style.background = 'none'; el.style.color = 'var(--t3)' } }}
    >
      {children}
    </button>
  )
}

// ── Item renderers ────────────────────────────────────────────────────────────

function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === 'message')          return <MessageRow msg={item} />
  if (item.kind === 'tool_call')        return <ToolCallRow tc={item} />
  if (item.kind === 'observer_message') return <ObserverRow obs={item} />
  if (item.kind === 'task_summary')     return <TaskSummaryRow summary={item} />
  return null
}

// ── Avatar (AI only) ──────────────────────────────────────────────────────────

const AV_AI: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
  display: 'grid', placeItems: 'center', marginTop: 2,
  fontSize: 11, fontWeight: 700,
  background: 'linear-gradient(135deg, var(--blue), var(--teal))', color: '#fff',
}

// ── Message row ───────────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: ChatMessage }) {
  const { t } = useI18n()
  const isUser = msg.role === 'user'

  if (isUser) {
    // User: column, right-aligned, no avatar
    return (
      <div className="msg-row" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4, flexDirection: 'row-reverse' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{t('chat.me')}</span>
          <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(msg.created_at)}</span>
        </div>
        <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={BUBBLE_USER}>
            {msg.images?.map((img, i) => <ImageView key={i} img={img} />)}
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{msg.content}</p>
          </div>
          <CopyButton text={msg.content} alignEnd />
        </div>
      </div>
    )
  }

  // AI: row, left-aligned, with avatar
  return (
    <div className="msg-row" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={AV_AI}>✦</div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>IPMaster-Cowork AI</span>
          <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(msg.created_at)}</span>
        </div>
        <div style={BUBBLE_AI}>
          {msg.images?.map((img, i) => <ImageView key={i} img={img} />)}
          {msg.reasoning && <ReasoningBlock text={msg.reasoning} />}
          <div className="prose prose-sm max-w-none msg-md">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{msg.content}</Markdown>
          </div>
        </div>
        <CopyButton text={msg.content} />
      </div>
    </div>
  )
}

// ── Streaming assistant bubble ─────────────────────────────────────────────────

function AssistantBubble({ content, images, reasoning, streaming }: { content: string; images: ChatImageData[]; reasoning?: string; streaming?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={AV_AI}>✦</div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>IPMaster-Cowork AI</span>
        </div>
        <div style={BUBBLE_AI}>
          {images.map((img, i) => <ImageView key={i} img={img} />)}
          {reasoning && <ReasoningBlock text={reasoning} defaultOpen={streaming} />}
          <div className="prose prose-sm max-w-none msg-md">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</Markdown>
          </div>
          {streaming && <span style={{
            display: 'inline-block', width: 2, height: 13, marginLeft: 2, verticalAlign: 'middle',
            background: 'var(--t3)', animation: 'pulse 1s infinite',
          }} />}
        </div>
      </div>
    </div>
  )
}

// ── Thinking dots row ─────────────────────────────────────────────────────────

// ── Activity strip (above input): vibe word / tool name + live duration ───────

function ActivityStrip({ activity }: { activity: ActivityState | null }) {
  const { t } = useI18n()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!activity) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [activity])
  if (!activity) return null
  const elapsed = Date.now() - new Date(activity.started_at).getTime()
  const lbl = activityLabel(activity, elapsed)
  const text = lbl.kind === 'tool'
    ? t('activity.tool', { tool: lbl.tool })
    : t(`activity.vibe.${lbl.phase}.${lbl.index}`)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '2px 4px 8px', fontSize: 12, color: 'var(--t2)',
      animation: 'msg-fade-up .2s ease both',
    }}>
      <Spinner className="h-3 w-3" />
      <span>{text}</span>
      <span style={{ color: 'var(--t3)' }}>· {formatDuration(elapsed)}</span>
    </div>
  )
}

// ── Tool call row (aligned with message rows, 16px padding) ───────────────────

function ToolCallRow({ tc }: { tc: ChatToolCall }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const argsStr = Object.keys(tc.arguments).length > 0 ? JSON.stringify(tc.arguments, null, 2) : ''
  // Tool failures are rendered neutrally (no red / no "error" wording): a failed
  // call shows a grey "已结束/Finished" instead of green "✓ 完成", and its detail
  // body uses the neutral "结果/Result" label. Avoids alarming users over
  // routine recoverable tool failures (MCP unreachable, skill non-zero exit, …).
  const statusColor = tc.is_error ? 'var(--t3)' : 'var(--green)'
  const statusLabel = tc.is_error ? t('chat.toolEnded') : t('chat.toolDone')
  return (
    <div style={{ padding: '3px 16px' }}>
      <div style={{
        borderRadius: 10, overflow: 'hidden', boxShadow: 'var(--shadow)',
        border: '1px solid var(--border)',
        background: 'var(--bg1)',
      }}>
        {/* Header */}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', width: '100%', alignItems: 'center', gap: 7,
            padding: '7px 11px', cursor: 'pointer', textAlign: 'left',
            background: 'var(--bg2)', border: 'none',
            transition: 'background var(--tr)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
        >
          {/* ⚙ icon in blue-dim square — neutral regardless of success/failure */}
          <span style={{
            width: 20, height: 20, borderRadius: 4, flexShrink: 0,
            display: 'grid', placeItems: 'center', fontSize: 10,
            background: 'var(--blue-dim)',
            color: 'var(--blue)',
          }}>⚙</span>
          <code style={{ flex: 1, fontFamily: 'monospace', fontSize: 11.5, color: 'var(--t2)', fontWeight: 500 }}>{tc.tool_name}</code>
          <span style={{ fontSize: 10.5, color: statusColor, flexShrink: 0 }}>{statusLabel}</span>
          <span style={{ fontSize: 9, color: 'var(--t3)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
        </button>
        {/* Body */}
        {open && (
          <div style={{
            padding: '9px 11px', fontFamily: 'monospace', fontSize: 11,
            color: 'var(--t2)', lineHeight: 1.6, background: 'var(--bg2)',
            borderTop: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {argsStr && (
              <div>
                <span style={{ color: 'var(--t3)', fontSize: 10 }}>{t('chat.args')}</span>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '3px 0 0', fontSize: 11, color: 'var(--t2)' }}>{argsStr}</pre>
              </div>
            )}
            {tc.result && (
              <div>
                <span style={{ color: 'var(--t3)', fontSize: 10 }}>{t('chat.result')}</span>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '3px 0 0', fontSize: 11, color: 'var(--t2)' }}>
                  {tc.result.length > 2000 ? tc.result.slice(0, 2000) + '\n' + t('chat.resultTruncated') : tc.result}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Observer row ──────────────────────────────────────────────────────────────

function ObserverRow({ obs }: { obs: ChatObserverMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ padding: '3px 16px' }}>
      <div style={{ borderLeft: '2px solid #c084fc', paddingLeft: 10 }}>
        <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#a855f7', background: 'none', border: 'none', cursor: 'pointer' }}>
          <Brain size={11} />
          <span>Observer {obs.round_label}</span>
          <span style={{ fontSize: 9 }}>{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.6, color: 'var(--t2)' }}>
            {obs.reasoning && <p style={{ marginBottom: 4, fontStyle: 'italic', color: 'var(--t3)' }}>{obs.reasoning}</p>}
            <p style={{ margin: 0 }}>{obs.content}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Task summary (finish_task 的总结) ─────────────────────────────────────────
// 根任务的 finish_task 总结 → 普通 AI 气泡。是否展示由 taskSummaryFromEvent 决定(只留根任务)。

function TaskSummaryRow({ summary }: { summary: ChatTaskSummary }) {
  return (
    <div className="msg-row" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={AV_AI}>✦</div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>IPMaster-Cowork AI</span>
          <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(summary.created_at)}</span>
        </div>
        <div style={BUBBLE_AI}>
          <div className="prose prose-sm max-w-none msg-md">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{summary.summary}</Markdown>
          </div>
        </div>
        <CopyButton text={summary.summary} />
      </div>
    </div>
  )
}

// ── Reasoning block (inside AI bubble) ───────────────────────────────────────

function ReasoningBlock({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div style={{ marginBottom: 8, paddingLeft: 8, borderLeft: '2px solid var(--border2)' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
        <Brain size={10} /> {t('chat.reasoning')} <span style={{ fontSize: 8 }}>{open ? '▲' : '▶'}</span>
      </button>
      {open && <p style={{ marginTop: 4, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.6, color: 'var(--t2)' }}>{text}</p>}
    </div>
  )
}

function ImageView({ img }: { img: ChatImageData }) {
  const src = img.source_type === 'base64' ? `data:${img.media_type};base64,${img.data}` : img.data
  return <img src={src} style={{ maxHeight: 256, maxWidth: '100%', borderRadius: 6, marginBottom: 8, objectFit: 'contain' }} />
}

// ── Bubble style constants ────────────────────────────────────────────────────

const BUBBLE_USER: React.CSSProperties = {
  display: 'inline-block',
  padding: '8px 12px', borderRadius: 12, borderTopRightRadius: 2,
  fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
  background: 'var(--blue)', color: '#fff', textAlign: 'left',
}

const BUBBLE_AI: React.CSSProperties = {
  display: 'block',
  padding: '8px 12px', borderRadius: 12, borderTopLeftRadius: 2,
  fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
  background: '#ffffff', border: '1px solid var(--border)', color: 'var(--t1)',
}

function WaitingInputPanel({ item, input, setInput, onSubmit, onAnswer, onApprove, onReject }: {
  item: ChatWaitingInput; input: string; setInput: (v: string) => void
  onSubmit: () => void; onAnswer: (text: string) => void; onApprove: () => void; onReject: () => void
}) {
  const { t } = useI18n()
  const isBash = item.input_type === 'bash_exec_confirm'
  // approval 类（含 bash 门控）渲染 Approve/Reject 按钮;input 类渲染文本框（spec/07）
  const isApproval = isBash || item.hitl_kind === 'approval'
  return (
    <div style={{
      borderRadius: 'var(--r)', border: `1px solid ${isBash ? 'rgba(234,88,12,.25)' : 'rgba(217,119,6,.25)'}`,
      background: isBash ? 'rgba(255,237,213,.5)' : 'rgba(254,243,199,.5)',
      padding: 12,
    }}>
      {isApproval ? (
        <>
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--amber)' }}>
            {isBash ? <><Terminal size={12} /> {t('chat.execConfirm')}</> : t('chat.agentNeedsApproval')}
          </div>
          {isBash && item.command && (
            <pre style={{ marginBottom: 8, overflowX: 'auto', borderRadius: 'var(--r)', background: 'var(--bg1)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 11, color: 'var(--t2)' }}>{item.command}</pre>
          )}
          {item.prompt && (
            <div className="prose prose-sm max-w-none msg-md" style={{ marginBottom: 8, fontSize: 12, color: 'var(--t2)' }}>
              <Markdown remarkPlugins={[remarkGfm]} components={hitlMdComponents}>{item.prompt}</Markdown>
            </div>
          )}
          {item.arguments && Object.keys(item.arguments).length > 0 && (
            <>
              <div style={{ marginBottom: 4, fontSize: 11, color: 'var(--t3)' }}>{t('chat.callArguments')}</div>
              <pre style={{ marginBottom: 8, maxHeight: 200, overflow: 'auto', borderRadius: 'var(--r)', background: 'var(--bg1)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 11, color: 'var(--t2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(item.arguments, null, 2)}</pre>
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={onApprove} style={{ background: 'var(--amber)', color: '#fff' }}>{t('chat.allow')}</Button>
            <Button size="sm" variant="outline" onClick={onReject}>{t('chat.reject')}</Button>
          </div>
        </>
      ) : item.questions && item.questions.length > 0 ? (
        <>
          <p style={{ marginBottom: 8, fontSize: 12, fontWeight: 500, color: 'var(--amber)' }}>{t('chat.agentNeedsInput')}</p>
          <StructuredQuestions questions={item.questions} onAnswer={onAnswer} />
        </>
      ) : (
        <>
          <p style={{ marginBottom: 8, fontSize: 12, fontWeight: 500, color: 'var(--amber)' }}>{t('chat.agentNeedsInput')}</p>
          {item.prompt && (
            <div className="prose prose-sm max-w-none msg-md" style={{ marginBottom: 8, fontSize: 13, color: 'var(--t2)' }}>
              <Markdown remarkPlugins={[remarkGfm]} components={hitlMdComponents}>{item.prompt}</Markdown>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && onSubmit()}
              style={{ flex: 1, borderRadius: 'var(--r)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 13, background: 'var(--bg1)', color: 'var(--t1)', outline: 'none' }}
              placeholder={t('chat.replyPlaceholder')}
            />
            <Button size="sm" disabled={!input.trim()} onClick={onSubmit}>{t('chat.send')}</Button>
          </div>
        </>
      )}
    </div>
  )
}

// ask_user 的结构化批量问题面板:每问单/多选 + 常驻"其他"文本框。提交时拼成统一编号文本走 onAnswer。
function StructuredQuestions({ questions, onAnswer }: { questions: AskQuestion[]; onAnswer: (text: string) => void }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected(prev => {
      const cur = prev[qi] || []
      if (multi) {
        const next = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]
        return { ...prev, [qi]: next }
      }
      // 单选:替换;再点同一项=取消
      return { ...prev, [qi]: cur.length === 1 && cur[0] === label ? [] : [label] }
    })
    if (!multi) setOther(prev => ({ ...prev, [qi]: '' }))   // 单选与"其他"互斥
  }

  function setOtherText(qi: number, val: string, multi: boolean) {
    setOther(prev => ({ ...prev, [qi]: val }))
    if (!multi && val.trim()) setSelected(prev => ({ ...prev, [qi]: [] }))  // 单选:填"其他"清掉选项
  }

  function answerFor(qi: number): string[] {
    const parts = [...(selected[qi] || [])]
    const o = (other[qi] || '').trim()
    if (o) parts.push(o)
    return parts
  }

  const allAnswered = questions.every((_, qi) => answerFor(qi).length > 0)

  function submit() {
    if (!allAnswered) return
    // 统一编号(单问也编号),多选/含"其他"用 ", " 连接
    const text = questions.map((q, qi) => `${qi + 1}. ${q.question} → ${answerFor(qi).join(', ')}`).join('\n')
    onAnswer(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {questions.map((q, qi) => {
        const multi = !!q.multi_select
        const cur = selected[qi] || []
        return (
          <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, fontSize: 13, color: 'var(--t1)' }}>
              <span style={{ color: 'var(--t3)', flexShrink: 0 }}>{qi + 1}.&nbsp;</span>
              <div className="prose prose-sm max-w-none" style={{ flex: 1, color: 'var(--t1)' }}>
                <Markdown remarkPlugins={[remarkGfm]} components={hitlMdComponents}>{q.question}</Markdown>
              </div>
              {multi && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--t3)', flexShrink: 0 }}>{t('chat.multiSelectHint')}</span>}
            </div>
            {(q.options && q.options.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {q.options.map((opt, oi) => {
                  const on = cur.includes(opt.label)
                  return (
                    <button key={oi} onClick={() => toggle(qi, opt.label, multi)} style={{
                      textAlign: 'left', borderRadius: 'var(--r)', padding: '7px 10px', cursor: 'pointer',
                      border: `1px solid ${on ? 'var(--amber)' : 'var(--border)'}`,
                      background: on ? 'rgba(254,243,199,.7)' : 'var(--bg1)',
                    }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t1)' }}>
                        {opt.label}
                        {opt.recommended && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)' }}>{t('chat.recommended')}</span>}
                      </div>
                      {opt.description && (
                        <div className="prose prose-sm max-w-none" style={{ marginTop: 2, fontSize: 11, color: 'var(--t2)' }}>
                          <Markdown remarkPlugins={[remarkGfm]} components={hitlMdComponents}>{opt.description}</Markdown>
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <input
              value={other[qi] || ''} onChange={e => setOtherText(qi, e.target.value, multi)}
              placeholder={t('chat.otherOption')}
              style={{ borderRadius: 'var(--r)', border: '1px solid var(--border)', padding: '5px 10px', fontSize: 12, background: 'var(--bg1)', color: 'var(--t1)', outline: 'none' }}
            />
          </div>
        )
      })}
      <div>
        <Button size="sm" disabled={!allAnswered} onClick={submit}>{t('chat.submit')}</Button>
      </div>
    </div>
  )
}

// ── Markdown overrides ────────────────────────────────────────────────────────

const mdComponents: React.ComponentProps<typeof Markdown>['components'] = {
  code({ className, children, ...props }) {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      return (
        <pre style={{ margin: '8px 0', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <code style={{ display: 'block', padding: '12px 14px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, background: '#f6f8fa', color: 'var(--t1)', overflowX: 'auto', whiteSpace: 'pre', border: 'none', borderRadius: 0 }} className={className} {...props}>{children}</code>
        </pre>
      )
    }
    return <code style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg3)', border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 4, color: 'var(--blue)' }} {...props}>{children}</code>
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)', textDecoration: 'underline' }}>{children}</a>
  },
  table({ children }) {
    return <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>{children}</table></div>
  },
  th({ children }) {
    return <th style={{ border: '1px solid var(--border)', padding: '5px 10px', background: 'var(--bg2)', fontWeight: 600, color: 'var(--t1)', textAlign: 'left' }}>{children}</th>
  },
  td({ children }) {
    return <td style={{ border: '1px solid var(--border)', padding: '5px 10px', textAlign: 'left' }}>{children}</td>
  },
  blockquote({ children }) {
    return <blockquote style={{ margin: '8px 0', padding: '6px 12px', borderLeft: '3px solid var(--border2)', color: 'var(--t3)', background: 'var(--bg2)', borderRadius: '0 4px 4px 0' }}>{children}</blockquote>
  },
}

// ask_user 面板用的紧凑 md 组件:段落无外边距,避免撑大弹窗
const hitlMdComponents: React.ComponentProps<typeof Markdown>['components'] = {
  ...mdComponents,
  p({ children }) { return <p style={{ margin: 0 }}>{children}</p> },
}
