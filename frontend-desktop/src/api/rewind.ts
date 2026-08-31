import { httpFor } from './client'

// 工作区文件检查点（不含文件内容，只有元数据）。
export interface Checkpoint {
  id: string
  turn: number | null
  label: string
  created_at: string
  file_count: number
  total_bytes: number
  skipped: number
}

export interface RestoreResult {
  restored: number
  deleted: number
  unchanged: number
  safety_checkpoint_id: string | null
}

// 一律按会话选后端：检查点存在**跑这个会话的那个后端**上（云端会话的快照在云端实例的
// 卷里，地端根本没有）。写死地端的话云端会话会静默拿到 404 → 可回滚回合集合为空 →
// 回退按钮一个都不渲染，表现成"云端没有回滚功能"而不是报错。
export const rewindApi = {
  listCheckpoints: (sessionId: string) =>
    httpFor(sessionId).get<{ checkpoints: Checkpoint[] }>(`/rewind/${encodeURIComponent(sessionId)}/checkpoints`),
  // 按用户回合回滚（对话里点某条用户消息的回退按钮）：回到那条消息动手之前的工作区状态。
  restoreToTurn: (sessionId: string, turn: number) =>
    httpFor(sessionId).post<RestoreResult>(`/rewind/${encodeURIComponent(sessionId)}/restore-to-turn`, { turn }),
  // 撤销最近一次回滚：把工作区恢复到那次回滚之前的安全档（safety_checkpoint_id 来自回滚记录）。
  undo: (sessionId: string, safetyCheckpointId: string, turn: number) =>
    httpFor(sessionId).post<RestoreResult>(`/rewind/${encodeURIComponent(sessionId)}/undo`,
      { safety_checkpoint_id: safetyCheckpointId, turn }),
}
