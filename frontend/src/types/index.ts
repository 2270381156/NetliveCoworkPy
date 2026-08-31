// ─── Session ────────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'WAITING_INPUT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'
  | 'PAUSED_HITL'
  | 'PAUSED'

export const TERMINAL_STATUSES: SessionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED']

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
  created_at: string
  updated_at: string
}

export interface InitialTaskConfig {
  title?: string | null
  use_subagent?: boolean
  subagent_template?: string | null
}

export interface CreateSessionRequest {
  user_prompt: string
  template_id?: string | null
  token_budget?: number
  llm_account?: string | null
  llm_model?: string | null
  workspace?: string | null
  initial_task?: InitialTaskConfig | null
}

export interface SendMessageRequest {
  content: string | object[]
  initial_task?: InitialTaskConfig | null
  llm_account?: string | null
  llm_model?: string | null
}

export type SessionConfig = Omit<CreateSessionRequest, 'user_prompt'>

// ─── Task ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'PENDING' | 'ACTIVE' | 'FINISHED' | 'FAILED' | 'CANCELED'

export interface Task {
  id: string
  session_id: string
  creator_agent_id: string
  assigned_agent_id: string
  title: string
  status: TaskStatus
  description: string
  user_prompt: string
  settings: Record<string, unknown>
  result: string | null
  outputs: Record<string, unknown>
  error: string | null
  created_at: string
  updated_at: string
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export type AgentStatus = 'IDLE' | 'RUNNING' | 'FINISHED' | 'FAILED'

export interface Agent {
  id: string
  session_id: string
  template_id: string | null
  name: string
  status: AgentStatus
  system_prompt: string
  tool_list: string[]
  skill_list: string[]
  loop_guard: { turns_used: number; max_turns: number }
}

// ─── AgentTemplate ───────────────────────────────────────────────────────────

/** 列表视图：只含元数据，不读文件 */
export interface AgentTemplate {
  id: string
  name: string
  version: string
  description: string
}

/** 详情视图：通过 GET /{id} 获取，从磁盘按需加载 */
export interface AgentTemplateDetail extends AgentTemplate {
  tool_refs: string[]    // capability_refs 的 id 列表（来自 SOUL.md + ROLE.md tools）
  has_soul: boolean      // SOUL.md 存在
  has_role: boolean      // ROLE.md 存在
  template_dir: string | null
}

export interface RegisterTemplateRequest {
  template_dir: string
}

// ─── LLM Account ─────────────────────────────────────────────────────────────

export type LLMStyle = 'openai' | 'anthropic'

export interface ModelConfig {
  name: string
  context_limit: number
  output_reserve: number | null
}

export interface ModelConfigInput {
  name: string
  context_limit?: number | null
  output_reserve?: number | null
}

export interface LLMAccount {
  name: string
  style: LLMStyle
  base_url: string
  models: ModelConfig[]
  default_model: string
  timeout_sec: number
}

export interface RegisterLLMAccountRequest {
  name: string
  style: LLMStyle
  api_key: string
  base_url?: string
  models?: ModelConfigInput[]
  default_model?: string
  timeout_sec?: number
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface MemoryMessage {
  id: string
  session_id: string
  role: MessageRole
  content: string
  task_id: string | null
  created_at: string
}

export interface MemorySummary {
  session_id: string
  content: string
  message_count: number
  created_at: string
}

// ─── ToolCall ────────────────────────────────────────────────────────────────

export type ToolCallStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export interface ToolCall {
  id: string
  session_id: string
  task_id: string | null
  agent_id: string
  tool_name: string
  status: ToolCallStatus
  arguments: Record<string, unknown>
  result: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

export type MCPServerType = 'stdio' | 'http'
export type MCPServerStatus = 'CONNECTED' | 'DISCONNECTED'

export interface MCPServer {
  name: string
  type: MCPServerType
  status: MCPServerStatus
  tool_count: number
  tools?: MCPTool[]
  command?: string | null
  args?: string[] | null
  url?: string | null
  timeout_per_call_sec: number
  connect_timeout_sec: number
}

export interface MCPTool {
  name: string
  description: string
}

export interface RegisterMCPStdioRequest {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  default_purposes?: string[]
  timeout_per_call_sec?: number
  connect_timeout_sec?: number
}

export interface RegisterMCPHttpRequest {
  name: string
  url: string
  headers?: Record<string, string>
  default_purposes?: string[]
  timeout_per_call_sec?: number
  connect_timeout_sec?: number
}

// ─── Remote Skill Source ─────────────────────────────────────────────────────

export interface RemoteSkillSource {
  source_name: string
  source_type: 'git'
  repo_url: string | null
  branch: string
  cache_dir: string
}

export interface RegisterGitSkillSourceRequest {
  source_name: string
  repo_url: string
  branch?: string
}

// ─── API Error ───────────────────────────────────────────────────────────────

export interface ApiError {
  code: string
  message: string
}
