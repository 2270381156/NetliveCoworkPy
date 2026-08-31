import { http } from './client'
import type { MCPServer, RegisterMCPStdioRequest, RegisterMCPHttpRequest } from '@/types'

export const mcpApi = {
  list: () => http.get<MCPServer[]>('/mcp-servers'),
  get: (name: string) => http.get<MCPServer>(`/mcp-servers/${name}`),
  registerStdio: (data: RegisterMCPStdioRequest) =>
    http.post<MCPServer>('/mcp-servers/stdio', data),
  registerHttp: (data: RegisterMCPHttpRequest) =>
    http.post<MCPServer>('/mcp-servers/http', data),
  refresh: (name: string) => http.post<MCPServer>(`/mcp-servers/${name}/refresh`),
  delete: (name: string) => http.delete(`/mcp-servers/${name}`),
}
