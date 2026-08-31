import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// 直接 mock 资源 API(hook 调它);无需 MSW。
vi.mock('@/api/llms', () => ({
  llmsApi: {
    list: vi.fn(),
    delete: vi.fn(),
    addModel: vi.fn(),
    pingRegistered: vi.fn(),
  },
}))

import { llmsApi } from '@/api/llms'
import { queryKeys } from '@/shared/api/queryKeys'
import { useLlmProviders, useDeleteProvider, useAddModel } from './hooks'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, wrapper }
}

const list = vi.mocked(llmsApi.list)
const del = vi.mocked(llmsApi.delete)
const addModel = vi.mocked(llmsApi.addModel)
const pingRegistered = vi.mocked(llmsApi.pingRegistered)

beforeEach(() => vi.clearAllMocks())

describe('useLlmProviders', () => {
  it('fetches via llmsApi.list and caches under queryKeys.llms()', async () => {
    const providers = [{ name: 'deepseek', style: 'openai', base_url: '', models: [], default_model: '', timeout_sec: 120 }]
    list.mockResolvedValue(providers as never)
    const { qc, wrapper } = makeWrapper()
    const { result } = renderHook(() => useLlmProviders(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(list).toHaveBeenCalledTimes(1)
    // 关键:数据落在 ['llms'] 这个 key 下(证明用了 queryKeys.llms())
    expect(qc.getQueryData(queryKeys.llms())).toEqual(providers)
  })
})

describe('useDeleteProvider', () => {
  it('invalidates the llms query after a successful delete', async () => {
    del.mockResolvedValue(undefined as never)
    const { qc, wrapper } = makeWrapper()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useDeleteProvider(), { wrapper })
    result.current.mutate('deepseek')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(del).toHaveBeenCalledWith('deepseek')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.llms() })
  })
})

describe('useAddModel', () => {
  it('throws when ping fails and does NOT persist the model', async () => {
    pingRegistered.mockResolvedValue({ ok: false, latency_ms: 0, error: '认证失败' } as never)
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useAddModel('deepseek'), { wrapper })
    result.current.mutate('bad-model')
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain('认证失败')
    expect(addModel).not.toHaveBeenCalled()
  })

  it('persists the model and invalidates after ping succeeds', async () => {
    pingRegistered.mockResolvedValue({ ok: true, latency_ms: 42 } as never)
    addModel.mockResolvedValue({} as never)
    const { qc, wrapper } = makeWrapper()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useAddModel('deepseek'), { wrapper })
    result.current.mutate('deepseek-v4-flash')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(pingRegistered).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash')
    expect(addModel).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash')
    expect(result.current.data?.latency).toBe(42)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.llms() })
  })
})
