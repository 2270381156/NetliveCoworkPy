"""rewind —— 工作区文件的检查点快照与回滚（自研，零外部依赖）。

只回滚**工作区文件**，不动对话/上下文（见《全自动模式安全设计》§6）。
核心引擎在 ``checkpoint_store``：内容寻址（相同内容只存一份）+ 每检查点一份清单。
"""

from netlivecowork.rewind.checkpoint_store import (
    Checkpoint,
    CheckpointStore,
    RestoreResult,
)

__all__ = ["Checkpoint", "CheckpointStore", "RestoreResult"]
