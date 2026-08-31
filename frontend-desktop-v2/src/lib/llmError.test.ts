import { describe, it, expect } from 'vitest'
import { classifyLlmFailure } from './llmError'

describe('classifyLlmFailure', () => {
  it('returns a terminal error for a non-retriable LLMCallError', () => {
    const c = classifyLlmFailure({ error_type: 'LLMCallError', error: '401 Unauthorized', will_retry: false })
    expect(c).toEqual({ error: { message: '401 Unauthorized' }, retrying: false })
  })

  it('flags retrying (no modal) for a retriable LLMCallError', () => {
    const c = classifyLlmFailure({ error_type: 'LLMCallError', error: 'timeout', will_retry: true })
    expect(c).toEqual({ error: null, retrying: true })
  })

  it('ignores non-LLM failures', () => {
    const c = classifyLlmFailure({ error_type: 'RuntimeError', error: 'boom', will_retry: false })
    expect(c).toBeNull()
  })

  it('ignores a task_failed with no error_type', () => {
    expect(classifyLlmFailure({ error: 'Task failed' })).toBeNull()
  })

  it('treats a missing will_retry as terminal', () => {
    const c = classifyLlmFailure({ error_type: 'LLMCallError', error: 'truncated response' })
    expect(c).toEqual({ error: { message: 'truncated response' }, retrying: false })
  })

  it('tolerates a missing error string on a terminal failure', () => {
    const c = classifyLlmFailure({ error_type: 'LLMCallError', will_retry: false })
    expect(c).toEqual({ error: { message: '' }, retrying: false })
  })
})
