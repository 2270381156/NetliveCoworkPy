/**
 * 把后端 `task_failed` SSE 事件归类为「LLM 调用错误」。
 *
 * 后端在 RUN_FINISHED 失败时发 { type:'task_failed', error, error_type, will_retry }。
 * error_type 是异常类名;LLM 调用失败时为 'LLMCallError'(认证失败 / 响应截断 / 传输重试耗尽)。
 *
 * - 终态失败(will_retry 假)→ 弹窗,error.message 为后端原始错误串。
 * - 可重试失败(will_retry 真)→ 仅内联「正在重试」提示,不弹窗(error=null)。
 * - 非 LLM 失败 → 返回 null,调用方应忽略(不动状态)。
 */

export interface LlmFailureEvent {
  error_type?: string
  error?: string
  will_retry?: boolean
}

export interface LlmFailureClassification {
  error: { message: string } | null
  retrying: boolean
}

export function classifyLlmFailure(evt: LlmFailureEvent): LlmFailureClassification | null {
  if (evt.error_type !== 'LLMCallError') return null
  if (evt.will_retry) return { error: null, retrying: true }
  return { error: { message: evt.error || '' }, retrying: false }
}
