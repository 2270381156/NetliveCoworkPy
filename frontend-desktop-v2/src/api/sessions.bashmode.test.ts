import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionsApi } from './sessions'

describe('bash review mode api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ mode: 'manual' }),
    })) as unknown as typeof fetch)
  })

  it('getBashReviewMode hits the right path', async () => {
    const out = await sessionsApi.getBashReviewMode('s1')
    expect(out.mode).toBe('manual')
    expect(fetch).toHaveBeenCalledWith('/api/v1/sessions/s1/bash-review-mode', expect.objectContaining({ method: 'GET' }))
  })

  it('setBashReviewMode PUTs the mode', async () => {
    await sessionsApi.setBashReviewMode('s1', 'manual')
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/sessions/s1/bash-review-mode',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ mode: 'manual' }) }),
    )
  })
})
