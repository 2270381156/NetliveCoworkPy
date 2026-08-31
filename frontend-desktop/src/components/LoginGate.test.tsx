import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ lang: 'zh' }) }))
import { LoginGate } from './LoginGate'

describe('LoginGate', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('W3 登录尚未返回时隐藏登录按钮并显示进入中占位', () => {
    const login = vi.fn(() => new Promise(() => {}))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      login,
      getLoginError: vi.fn().mockResolvedValue(null),
    }

    render(<LoginGate onLogin={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'W3 登录' }))

    expect(screen.queryByRole('button', { name: 'W3 登录' })).toBeNull()
    expect(screen.getByText('正在进入…')).toBeTruthy()
  })

  it('W3 登录失败后恢复登录按钮并显示错误', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      login: vi.fn().mockRejectedValue(new Error('认证服务不可用')),
      getLoginError: vi.fn().mockResolvedValue(null),
    }

    render(<LoginGate onLogin={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'W3 登录' }))

    expect(await screen.findByText('认证服务不可用')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'W3 登录' })).toBeTruthy()
  })

  it('W3 白名单拒绝后恢复登录按钮并显示拒绝原因', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      login: vi.fn().mockResolvedValue({ __notInWhitelist: true, message: '未开通权限' }),
      getLoginError: vi.fn().mockResolvedValue(null),
    }

    render(<LoginGate onLogin={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'W3 登录' }))

    expect(await screen.findByText('未开通权限')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'W3 登录' })).toBeTruthy()
  })
})
