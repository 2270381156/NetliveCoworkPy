// finish_task 总结渲染判定(纯逻辑,便于单测)。
// 只展示该 session 根任务的 finish_task 总结(根任务是编排者,其 finish_task 即整个会话的收尾)——
// 根任务的总结无论如何都展示,所有子任务的总结一律不展示。

export interface FinishTaskEvent {
  tool_name?: string
  arguments?: { result?: unknown } & Record<string, unknown>
  is_root?: boolean
}

export interface TaskSummaryData {
  summary: string
}

/** SSE 的 tool_name 是 capability_name(provider__name 形式),finish_task 实际下发为
 *  'control__finish_task';历史/测试里也可能是裸名 'finish_task'。两者都认。 */
function isFinishTask(name?: string): boolean {
  return name === 'control__finish_task' || name === 'finish_task'
}

/** control_tool_call 事件 → 根任务的总结数据;非 finish_task / 非根任务 / 无总结文本返回 null。 */
export function taskSummaryFromEvent(evt: FinishTaskEvent): TaskSummaryData | null {
  if (!isFinishTask(evt.tool_name)) return null
  if (!evt.is_root) return null
  const summary = String(evt.arguments?.result ?? '').trim()
  if (!summary) return null
  return { summary }
}
