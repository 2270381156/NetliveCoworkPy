from __future__ import annotations

from pydantic import BaseModel


class WorkspaceEntry(BaseModel):
    name: str
    path: str          # 绝对路径——前端导航时直接当下一次的 path
    is_dir: bool
    size: int | None = None  # 目录为 None


class WorkspaceListing(BaseModel):
    root: str
    path: str
    parent: str
    entries: list[WorkspaceEntry]


class DraftRootRequest(BaseModel):
    path: str  # 新建会话草稿里用户选的工作目录（绝对路径）


class WorkspaceUploadResult(BaseModel):
    """一次上传的结果。整批要么全落盘、要么在写入前就被拒（配额/大小/文件名）。"""
    root: str
    path: str                        # 落盘所在目录
    uploaded: list[WorkspaceEntry]
