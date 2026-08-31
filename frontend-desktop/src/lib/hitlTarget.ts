import { hitlApi } from '@/api/hitl'
import type { ChatWaitingInput } from '@/hooks/useSessionSSE'

// 解析应答目标:SSE 带的 hitl_id 优先;没有(旧 snapshot)→ 查 pending 按 form 匹配;
// wi=null(PAUSED 软待命,无面板)→ 取 form=wait 那条。查不到 → null(调用方兜底旧 /messages 通道)。
// 放在 lib 而非 ChatPanel:自动发送队列消息(useQueueDrainer)在没打开该会话时也要用同一套判定。
export async function resolveHitlId(sessionId: string, wi: ChatWaitingInput | null): Promise<string | null> {
  if (wi?.hitl_id) return wi.hitl_id
  try {
    const pending = await hitlApi.pending(sessionId)
    if (!wi) return pending.find(p => p.form === 'wait')?.id ?? null
    const wantApproval = wi.hitl_kind === 'approval'
    return (pending.find(p => (p.form === 'approval') === wantApproval) ?? pending[0])?.id ?? null
  } catch {
    return null
  }
}
