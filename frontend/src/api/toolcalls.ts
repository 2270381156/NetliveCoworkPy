import { http } from './client'
import type { ToolCall } from '@/types'

export const toolCallsApi = {
  list: (sessionId: string) =>
    http.get<ToolCall[]>(`/tools/sessions/${sessionId}/tool-calls`),
}
