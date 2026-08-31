"""RewindManager —— 把 CheckpointStore 接到会话回合边界。

快照时机（Claude Code 式，和对话对齐）：**每个真实用户回合开始前**，由 host 在
`create_session`（首轮）/ `send_message`（后续）里显式调用 `snapshot_turn`，用该回合的
`turn_seq` 标记。快照拍的是"这一回合动手之前"的工作区状态 → 回滚到某回合 = 撤销那条
用户消息及其之后的所有文件改动。

只管**工作区文件**；对话/上下文不动（《全自动模式安全设计》§6）。回滚只影响文件、不改历史。
异常一律吞掉、只记日志——rewind 是附加能力，绝不能拖垮会话主路径。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path

from netlivecowork.rewind.checkpoint_store import Checkpoint, CheckpointStore, RestoreResult

logger = logging.getLogger(__name__)


class RewindManager:
    """每会话一个 CheckpointStore。host 在回合边界调 snapshot_turn；对外提供列 / 按回合回滚。"""

    def __init__(
        self,
        checkpoints_root: str | Path,
        workspace_lookup: Callable[[str], str | None],
        *,
        keep: int,
        max_file_mb: int,
    ) -> None:
        self._root = Path(checkpoints_root)
        self._workspace_lookup = workspace_lookup
        self._keep = keep
        self._max_file_bytes = max_file_mb * 1024 * 1024
        self._stores: dict[str, CheckpointStore] = {}

    # ── host 在回合边界调用 ────────────────────────────────────────────────────
    async def snapshot_turn(self, session_id: str, turn: int, workspace: str | None) -> None:
        """在某回合动手【之前】拍一张快照，标记该回合的 turn_seq。workspace 缺失则 no-op。

        幂等：同一 turn 已有快照则跳过（重复调用/重放不会拍重复）。文件遍历放线程池，
        此刻工作区静止（上一回合已结束、本回合尚未跑），快照一致。
        """
        try:
            if not workspace or not Path(workspace).exists():
                return
            store = self._store(session_id)
            if any(c.turn == turn for c in store.list()):
                return
            ckpt = await asyncio.to_thread(store.snapshot, workspace, turn=turn, label="")
            logger.info("rewind: 快照 session=%s turn=%s %s files=%d",
                        session_id, turn, ckpt.id, ckpt.file_count)
        except Exception:
            logger.exception("RewindManager.snapshot_turn 失败 session=%s turn=%s", session_id, turn)

    async def on_event(self, event) -> None:
        """仅在 SessionFinished 释放内存（磁盘检查点保留）。"""
        try:
            if getattr(event, "type", None) == "SessionFinished":
                self._stores.pop(getattr(event, "session_id", ""), None)
        except Exception:
            logger.debug("RewindManager.on_event 忽略异常", exc_info=True)

    # ── 对外（API 用）────────────────────────────────────────────────────────
    def list(self, session_id: str) -> list[Checkpoint]:
        return self._store(session_id).list()

    def restore_turn(self, session_id: str, turn: int, workspace: str | None = None) -> RestoreResult:
        """回滚到某回合（该回合动手之前的状态）。workspace 显式给则用它，否则回退到 lookup。

        snapshot_before=True：回滚前先给"当前状态"存一张安全档，其 id 随 RestoreResult 返回，
        供前端「撤销回滚」把工作区恢复到本次回滚之前（安全档 turn=None，不进可回滚回合列表）。
        """
        ckpt = next((c for c in self._store(session_id).list() if c.turn == turn), None)
        if ckpt is None:
            raise KeyError(f"回合 {turn} 无检查点")
        return self._restore(session_id, ckpt.id, workspace, snapshot_before=True)

    def restore(self, session_id: str, checkpoint_id: str, workspace: str | None = None,
                *, snapshot_before: bool = False) -> RestoreResult:
        """按检查点 id 回滚。撤销回滚走这里（传安全档 id、snapshot_before=False，撤销即最终、不做 redo）。"""
        return self._restore(session_id, checkpoint_id, workspace, snapshot_before=snapshot_before)

    # ── 内部 ──────────────────────────────────────────────────────────────────
    def _restore(self, session_id: str, checkpoint_id: str, workspace: str | None = None,
                 *, snapshot_before: bool = False) -> RestoreResult:
        # 优先用调用方（API 从 session entry）显式传入的 workspace——和 snapshot 同源，
        # 避免 fs_provider 登记时序导致 lookup 返回 None。
        ws = workspace or self._workspace_lookup(session_id)
        if ws is None:
            raise RuntimeError(f"会话 {session_id} 未登记工作区，无法回滚")
        return self._store(session_id).restore(ws, checkpoint_id, snapshot_before=snapshot_before)

    def _store(self, session_id: str) -> CheckpointStore:
        store = self._stores.get(session_id)
        if store is None:
            store = CheckpointStore(
                self._root / session_id,
                max_file_bytes=self._max_file_bytes,
                max_checkpoints=self._keep,
            )
            self._stores[session_id] = store
        return store
