import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { Session } from '@/types'

const renameTitle = vi.fn()
vi.mock('@/api/sessions', () => ({
  sessionsApi: { renameTitle: (...args: unknown[]) => renameTitle(...args) },
}))

import { EditableSessionTitle } from './EditableSessionTitle'

const SESSION: Session = {
  id: 'ses_1', user_prompt: '原始问题', title: '', goal: 'AI 自动标题', status: 'SUCCEEDED',
  template_id: 'agent:default', root_agent_id: 'agt_1', token_budget: 1000,
  input_tokens_used: 0, output_tokens_used: 0, context_tokens: 0, failure_counter: 0,
  llm_account: null, llm_model: null, workspace: '/tmp/demo',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
}

function setup(count = 1, props: Partial<ComponentProps<typeof EditableSessionTitle>> = {}) {
  const session = props.session ?? SESSION
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData<Session[]>(['sessions'], [session])
  render(
    <QueryClientProvider client={client}>
      {Array.from({ length: count }, (_, index) => (
        <EditableSessionTitle key={index} session={session} mode="inline" {...props} />
      ))}
    </QueryClientProvider>,
  )
  return client
}

function clickEditButton(titleIndex = 0) {
  const title = screen.getAllByText('AI 自动标题')[titleIndex]
  const titleRoot = title.parentElement!.parentElement!
  fireEvent.mouseEnter(titleRoot)
  fireEvent.click(within(titleRoot).getByRole('button', { name: '修改会话标题' }))
}

describe('EditableSessionTitle', () => {
  test('点击编辑图标后按 Enter 保存修剪后的标题并同步会话缓存', async () => {
    renameTitle.mockResolvedValueOnce({ ...SESSION, title: '手动标题' })
    const client = setup()

    clickEditButton()
    const input = screen.getByRole('textbox')
    expect(input).toHaveValue('AI 自动标题')
    fireEvent.change(input, { target: { value: '  手动标题  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameTitle).toHaveBeenCalledWith('ses_1', '手动标题'))
    await screen.findByText('手动标题')
    expect(client.getQueryData<Session[]>(['sessions'])?.[0].title).toBe('手动标题')
  })

  test('按 Escape 取消且不调用后台接口', () => {
    renameTitle.mockClear()
    setup()

    clickEditButton()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '不保存' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('AI 自动标题')).toBeInTheDocument()
    expect(renameTitle).not.toHaveBeenCalled()
  })

  test('输入框失焦时使用同一个保存操作', async () => {
    renameTitle.mockResolvedValueOnce({ ...SESSION, title: '失焦保存' })
    setup()

    clickEditButton()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '失焦保存' } })
    fireEvent.blur(input)

    await waitFor(() => expect(renameTitle).toHaveBeenCalledWith('ses_1', '失焦保存'))
  })

  test('后台保存失败时保留编辑内容供用户重试', async () => {
    renameTitle.mockRejectedValueOnce(new Error('network'))
    setup()

    clickEditButton()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '待重试标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameTitle).toHaveBeenCalledWith('ses_1', '待重试标题'))
    expect(screen.getByRole('textbox')).toHaveValue('待重试标题')
  })

  test('列表与面板的两个标题实例保持同步', async () => {
    renameTitle.mockResolvedValueOnce({ ...SESSION, title: '同步标题' })
    setup(2)

    clickEditButton(0)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '同步标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getAllByText('同步标题')).toHaveLength(2))
  })

  test('列表标题使用完整宽度且悬停操作覆盖在标题右侧', () => {
    setup(1, {
      mode: 'modal',
      trailingActions: (
        <>
          <button type="button" aria-label="置顶" />
          <button type="button" aria-label="归档" />
          <button type="button" aria-label="删除" />
        </>
      ),
    })

    expect(screen.queryByRole('button', { name: '修改会话标题' })).toBeNull()
    const viewport = screen.getByText('AI 自动标题').parentElement!
    expect(viewport).toHaveStyle({ maxWidth: '100%' })
    fireEvent.mouseEnter(viewport.parentElement!)

    const actions = screen.getByTestId('session-title-actions')
    expect(actions).toHaveClass('absolute', 'right-0')
    expect(within(actions).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      '修改会话标题', '置顶', '归档', '删除',
    ])
    const editButton = within(actions).getByRole('button', { name: '修改会话标题' })
    expect(editButton).toHaveStyle({ color: 'var(--t3)' })
    fireEvent.mouseEnter(editButton)
    expect(editButton).toHaveStyle({ color: 'var(--blue)' })
    fireEvent.mouseLeave(editButton)
    expect(editButton).toHaveStyle({ color: 'var(--t3)' })
    fireEvent.mouseEnter(viewport.parentElement!)
    fireEvent.click(screen.getByRole('button', { name: '修改会话标题' }))
    const dialog = screen.getByRole('dialog', { name: '修改会话标题' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('textbox')).toHaveValue('AI 自动标题')
    expect(screen.getByText('保持简短且易于识别')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(screen.queryByText('编辑')).toBeNull()
  })

  test('列表标题模态框点击取消时关闭且不保存', () => {
    renameTitle.mockClear()
    setup(1, { mode: 'modal' })

    clickEditButton()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不应保存' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(renameTitle).not.toHaveBeenCalled()
  })

  test('列表标题模态框点击保存时提交新标题', async () => {
    renameTitle.mockResolvedValueOnce({ ...SESSION, title: '模态框标题' })
    setup(1, { mode: 'modal' })

    clickEditButton()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '模态框标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('模态框标题')
  })

  test('未选中的列表标题单击只交给列表选择，不打开编辑浮层', () => {
    const onSelect = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData<Session[]>(['sessions'], [SESSION])
    render(
      <QueryClientProvider client={client}>
        <div onClick={onSelect}>
          <EditableSessionTitle session={SESSION} mode="modal" />
        </div>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByText('AI 自动标题'))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('单击或双击标题文字都不会进入编辑', () => {
    setup(1, { mode: 'modal' })

    const title = screen.getByText('AI 自动标题')
    fireEvent.click(title)
    fireEvent.doubleClick(title)

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('会话面板持续展示铅笔且交互样式与上报按钮一致', () => {
    setup(1, { mode: 'inline' })

    const title = screen.getByText('AI 自动标题')
    const editButton = screen.getByRole('button', { name: '修改会话标题' })
    expect(editButton).toHaveClass('h-7', 'w-7', 'rounded-md', 'transition-colors')
    expect(editButton).toHaveStyle({ background: 'none', color: 'var(--t3)' })

    fireEvent.mouseEnter(editButton)
    expect(editButton).toHaveStyle({ background: 'var(--bg3)', color: 'var(--t2)' })
    fireEvent.mouseLeave(editButton)
    expect(editButton).toHaveStyle({ background: 'none', color: 'var(--t3)' })

    fireEvent.click(editButton)
    expect(screen.getByRole('textbox')).toHaveValue('AI 自动标题')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(title).not.toBeInTheDocument()
  })

  test('标题溢出时悬停自动滚动，移开后复位', () => {
    const longTitle = '这是一个非常长并且需要滚动才能完整展示的会话标题'
    setup(1, { session: { ...SESSION, title: longTitle }, mode: 'modal' })
    const text = screen.getByText(longTitle)
    const viewport = text.parentElement!
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 320 })
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 120 })

    fireEvent.mouseEnter(viewport)
    expect(text).toHaveStyle({ animationName: 'session-title-scroll' })

    fireEvent.mouseLeave(viewport)
    expect(text).not.toHaveStyle({ animationName: 'session-title-scroll' })
  })

  test('标题未溢出时悬停保持静止', () => {
    setup(1, { mode: 'modal' })
    const text = screen.getByText('AI 自动标题')
    const viewport = text.parentElement!
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 100 })
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 100 })

    fireEvent.mouseEnter(viewport)
    expect(text).not.toHaveStyle({ animationName: 'session-title-scroll' })
  })
})
