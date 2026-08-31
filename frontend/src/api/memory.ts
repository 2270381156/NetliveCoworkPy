import { http } from './client'
import type { MemoryMessage, MemorySummary } from '@/types'

export const memoryApi = {
  getMessages: (sessionId: string, limit = 100) =>
    http.get<MemoryMessage[]>(`/memories/sessions/${sessionId}/messages?limit=${limit}`),
  getSummary: (sessionId: string) =>
    http.get<MemorySummary | null>(`/memories/sessions/${sessionId}/summary`),
}
