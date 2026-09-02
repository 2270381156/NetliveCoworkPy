export type SessionStatus =
  | 'QUEUED' | 'RUNNING' | 'WAITING_INPUT'
  | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'INTERRUPTED' | 'PAUSED_HITL' | 'PAUSED'

export const TERMINAL_STATUSES: SessionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED']

// 桌面端浏览器登录后的云端用户（来自 /api/oauth/token 的 user 字段，或 W3 认证的 user 字段）
export interface AuthUser {
  id: string
  username: string
  role: string
  displayName?: string   // W3 用户信息
  email?: string         // W3 用户信息
}

export interface Session {
  id: string
  user_prompt: string
  /** 用户手动标题；有值时永久优先于 AI 自动维护的 goal。 */
  title?: string
  goal: string
  status: SessionStatus
  template_id: string | null
  root_agent_id: string | null
  token_budget: number
  input_tokens_used: number      // 累计实际未缓存输入（2026-07-16 起不再是 prompt 总输入）
  output_tokens_used: number
  context_tokens: number
  cache_read_tokens_used?: number   // 累计缓存命中
  cache_write_tokens_used?: number  // 累计缓存写入
  failure_counter: number
  llm_account: string | null
  llm_model: string | null
  workspace: string
  created_at: string
  updated_at: string
  last_activity_at?: string   // 最后一次真实活动时间（后端算，排除恢复态记帐事件）；排序/展示用
  /**
   * 会话跑在哪（云地协同）。**不是后端字段**——由客户端在拉取时按「这条会话来自
   * 哪个后端」标注（见 api/backends.ts）。缺省视为 local。
   */
  location?: 'local' | 'cloud'
}

export interface CreateSessionRequest {
  user_prompt: string
  /** 云端：用户选定的工作区文件夹名。后端拼在存储根之下——传名字而非路径。 */
  workspace_folder?: string | null
  template_id?: string | null
  token_budget?: number
  llm_account?: string | null
  llm_model?: string | null
  workspace?: string | null
  user_info?: AuthUser | null
  initial_task?: Record<string, unknown> | null   // 如 { skill_name }，绑定根 task
  mode?: 'semiauto' | 'manual' | 'strict-auto'     // 新建时选的工作模式；空=后端回落默认
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
  // 随包默认账号：选择器里显示、可选，但不在 LLM 配置页出现（不可删/改）。
  locked?: boolean
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
  /**
   * 这条会话要跟哪个 agent 聊（见 agents/registry）。创建时转成 template_id 发给后端。
   * 可选：branding 里没配 agent 阵容时没有这一层；老草稿也没有这个字段。
   */
  agentId?: string
  workingDir: string          // 云端会话为空——云端不选本地目录，改为上传文件
  provider: string
  model: string
  user?: AuthUser | null
  /** 会话跑在哪（云地协同）。缺省视为 local，兼容此前建的草稿。 */
  location?: 'local' | 'cloud'
  /**
   * 云端会话选定/新建的工作区文件夹**名**（不是路径）。与本地的 workingDir 对称：
   * 同一个文件夹可以承载多个会话。不选则由后端按会话 id 派生一个目录。
   */
  cloudFolder?: string
  /**
   * 上面那个文件夹的**绝对路径**（如 `/data/workspace/proj1`）。
   *
   * 只用于草稿期让工作区面板浏览它——与本地草稿浏览 workingDir 完全对称。**建会话仍然
   * 只发 cloudFolder 这个名字**，路径不参与，客户端因此无从指定容器内的任意目录
   * （见后端 _resolve_workspace 的注释）。
   */
  cloudFolderPath?: string
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
