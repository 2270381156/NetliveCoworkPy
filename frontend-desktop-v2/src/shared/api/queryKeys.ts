// 集中所有 React Query key(架构文档 §3.2)。
// 用途:① 每个 feature 的数据 hook 用它做 queryKey;
//       ② 跨切面缓存失效统一引用这里(如 chat mutation 失效 sessions 列表),
//          只 import shared/api/queryKeys、不 import 对方 feature。
export const queryKeys = {
  sessions: () => ['sessions'] as const,
  llms: () => ['llms'] as const,
  bashReviewMode: (sessionId: string) => ['bash-review-mode', sessionId] as const,
  skills: () => ['skills'] as const,
  skillCatalog: (username?: string) =>
    username === undefined ? (['skill-catalog'] as const) : (['skill-catalog', username] as const),
  authSession: () => ['auth-session'] as const,
  workspaceFiles: (path: string) => ['workspace-files', path] as const,
}
