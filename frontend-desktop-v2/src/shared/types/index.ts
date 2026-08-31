// 共享数据契约类型(后端 API 的结构描述,无运行时行为)。
// 铁律二边界:纯类型声明可放 shared/types(见架构文档 §2 边界澄清)。
// 注:PendingSession / CreateSessionRequest 偏 app/chat 领域,后续(Step 2/4)可迁到对应层;
//     此处暂置以便 @/types 旧路径整体 re-export,保持迁移期不破。

export type SessionStatus =
  | 'QUEUED' | 'RUNNING' | 'WAITING_INPUT'
  | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'INTERRUPTED' | 'PAUSED_HITL' | 'PAUSED'

export const TERMINAL_STATUSES: SessionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED']

// 桌面端浏览器登录后的云端用户（来自 /api/oauth/token 的 user 字段）
export interface AuthUser {
  id: string
  username: string
  role: string
}

export interface Session {
  id: string
  user_prompt: string
  goal: string
  status: SessionStatus
  template_id: string | null
  root_agent_id: string | null
  token_budget: number
  input_tokens_used: number
  output_tokens_used: number
  context_tokens: number
  failure_counter: number
  llm_account: string | null
  llm_model: string | null
  workspace: string
  created_at: string
  updated_at: string
}

export interface CreateSessionRequest {
  user_prompt: string
  template_id?: string | null
  token_budget?: number
  llm_account?: string | null
  llm_model?: string | null
  workspace?: string | null
}

export type LLMStyle = 'openai' | 'anthropic'

export interface ModelConfig {
  name: string
  context_limit: number
}

export interface LLMProvider {
  name: string
  style: LLMStyle
  base_url: string
  models: ModelConfig[]
  default_model: string
  timeout_sec: number
}

export interface RegisterLLMRequest {
  name: string
  style: LLMStyle
  api_key: string
  base_url?: string
  models?: { name: string; context_limit?: number | null }[]
  default_model?: string
  timeout_sec?: number
}

export interface PendingSession {
  workingDir: string
  provider: string
  model: string
}

export interface WorkspaceEntry {
  name: string
  path: string
  is_dir: boolean
  size: number | null
}

export interface WorkspaceListing {
  root: string
  path: string
  parent: string
  entries: WorkspaceEntry[]
}
