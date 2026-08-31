"""把单个会话的 DB 行导出为一个独立 SQLite 文件(ORM 行拷贝,源无关)。

读路径用现有 async session_factory(SQLite 或 Postgres 都行),逐表把目标会话的行
读成普通 dict;再用一个临时 sync sqlite 引擎按同一 Base.metadata 建表并灌入。产物
schema 与 app 完全一致,管理员可直接置换进 viewer 按事件溯源重放。

排除全局表 agent_templates 的数据(create_all 仍建它的 schema,保持一致)。
契约见 docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md §3。
"""
from __future__ import annotations

import asyncio
import gzip
import os
import tempfile
from pathlib import Path

from sqlalchemy import create_engine, select

from netlivecowork.persistence.postgres.models import (
    Base, SessionModel, TaskModel, EventModel, MemoryEventModel,
    MemorySubscriptionModel, SessionSSEEventModel, SnapshotModel,
)


class SessionNotFoundError(Exception):
    """目标会话的 sessions 行不存在 → 路由层转 404。"""


# (model, 过滤列) —— SessionModel 按主键 id,其余按 session_id。
# SessionModel 在最前:tasks/snapshots 有 FK → sessions,先插 sessions 行。
_SESSION_TABLES = [
    (SessionModel, SessionModel.id),
    (TaskModel, TaskModel.session_id),
    (EventModel, EventModel.session_id),
    (MemoryEventModel, MemoryEventModel.session_id),
    (MemorySubscriptionModel, MemorySubscriptionModel.session_id),
    (SessionSSEEventModel, SessionSSEEventModel.session_id),
    (SnapshotModel, SnapshotModel.session_id),
]


async def _read_session_rows(session_id: str, factory) -> dict:
    """逐表读目标会话的行为 [{col: value}]。会话不存在 → SessionNotFoundError。"""
    collected: dict = {}
    async with factory() as db:
        if await db.get(SessionModel, session_id) is None:
            raise SessionNotFoundError(session_id)
        for model, col in _SESSION_TABLES:
            rows = (await db.execute(select(model).where(col == session_id))).scalars().all()
            cols = [c.name for c in model.__table__.columns]
            collected[model.__tablename__] = [
                {name: getattr(r, name) for name in cols} for r in rows
            ]
    return collected


def _write_sqlite_bytes(collected: dict) -> bytes:
    """把收集到的行写进一个全新 sqlite 文件,返回其字节。"""
    fd, tmp = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    try:
        engine = create_engine(f"sqlite:///{Path(tmp).as_posix()}")
        try:
            Base.metadata.create_all(engine)
            with engine.begin() as conn:
                for model, _col in _SESSION_TABLES:
                    rows = collected.get(model.__tablename__) or []
                    if rows:
                        conn.execute(model.__table__.insert(), rows)
        finally:
            engine.dispose()
        return Path(tmp).read_bytes()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _build_export_bytes(collected: dict) -> bytes:
    """写出原始 sqlite 字节后整包 gzip —— 未压缩 JSON 文本冗余大,压缩后接近 RAR 比。

    level 9:单会话数据有界,一次性管理动作,体积优先。导入侧 (_read_dump) 按 gzip
    magic 嗅探透明解压,旧的未压缩 dump 仍兼容。
    """
    raw = _write_sqlite_bytes(collected)
    return gzip.compress(raw, compresslevel=9)


async def export_session_db(session_id: str, factory) -> bytes:
    collected = await _read_session_rows(session_id, factory)
    # sync sqlite 写入 + gzip 放线程,避免阻塞事件循环。
    return await asyncio.to_thread(_build_export_bytes, collected)
