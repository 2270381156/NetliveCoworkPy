import { useQuery } from '@tanstack/react-query'
import { sessionsApi } from '@/api/sessions'
import { memoryApi } from '@/api/memory'
import { toolCallsApi } from '@/api/toolcalls'
import { isTerminalSession } from '@/lib/status'

const POLL_INTERVAL = 2000

function pollInterval(status: string | undefined) {
  if (!status) return POLL_INTERVAL
  return isTerminalSession(status as Parameters<typeof isTerminalSession>[0])
    ? false
    : POLL_INTERVAL
}

export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => sessionsApi.get(sessionId!),
    enabled: !!sessionId,
    refetchInterval: (q) => pollInterval(q.state.data?.status),
  })
}

export function useSessionTasks(sessionId: string | null, sessionStatus?: string) {
  return useQuery({
    queryKey: ['session-tasks', sessionId],
    queryFn: () => sessionsApi.getTasks(sessionId!),
    enabled: !!sessionId,
    refetchInterval: pollInterval(sessionStatus),
  })
}

export function useSessionMessages(sessionId: string | null, sessionStatus?: string) {
  return useQuery({
    queryKey: ['session-messages', sessionId],
    queryFn: () => memoryApi.getMessages(sessionId!),
    enabled: !!sessionId,
    refetchInterval: pollInterval(sessionStatus),
  })
}

export function useSessionToolCalls(sessionId: string | null, sessionStatus?: string) {
  return useQuery({
    queryKey: ['session-tool-calls', sessionId],
    queryFn: () => toolCallsApi.list(sessionId!),
    enabled: !!sessionId,
    refetchInterval: pollInterval(sessionStatus),
  })
}
