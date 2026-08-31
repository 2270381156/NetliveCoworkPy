"""SQLAlchemy 2.0 async ORM models for ctx-weft."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class SessionModel(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    user_prompt: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="RUNNING", index=True)
    goal: Mapped[str] = mapped_column(Text, default="")
    root_agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    llm_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    llm_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    token_budget: Mapped[int] = mapped_column(BigInteger, default=200_000)
    failure_counter: Mapped[int] = mapped_column(Integer, default=0)
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    # agent 工作目录（绝对路径）。host 自有数据，非事件派生——由 host 在 start_session 后
    # 直接写入（见 PostgresStateStore.save_workspace）。详见 protocols/filesystem 的分层约定。
    workspace: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TaskModel(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), ForeignKey("sessions.id"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="PENDING", index=True)
    title: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    user_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    assigned_agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    creator_agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_daemon: Mapped[bool] = mapped_column(Boolean, default=False)
    outputs_json: Mapped[str] = mapped_column(Text, default="null")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EventModel(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tenant_id: Mapped[str] = mapped_column(String(64), default="default")
    type: Mapped[str] = mapped_column(String(128), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    payload_json: Mapped[str] = mapped_column(Text, default="{}")
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    causation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_events_run_seq", "run_id", "sequence"),
        Index("ix_events_session_type", "session_id", "type"),
    )


class MemoryEventModel(Base):
    __tablename__ = "memory_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    layer: Mapped[str] = mapped_column(String(16), default="task", index=True)  # spec/06 §2
    type: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    topic: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text)
    seq_no: Mapped[int] = mapped_column(Integer)
    topic_seq_no: Mapped[int] = mapped_column(Integer, default=0)
    is_superseded: Mapped[bool] = mapped_column(Boolean, default=False)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_memory_task", "session_id", "layer", "task_id", "type"),
        Index("ix_memory_agent", "session_id", "layer", "agent_id", "type"),
    )


class MemorySubscriptionModel(Base):
    __tablename__ = "memory_subscriptions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    task_id: Mapped[str] = mapped_column(String(64), default="")  # 订阅方任务；"" = session 级
    topic: Mapped[str] = mapped_column(String(256))
    cursor: Mapped[int] = mapped_column(Integer, default=0)
    intent: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_subscriptions_session_task_topic", "session_id", "task_id", "topic", unique=True),
    )


class SessionSSEEventModel(Base):
    """Translated SSE events for a session (miniAgents frontend protocol format).

    Stored in insertion order via autoincrement id.
    text_delta / reasoning_delta are excluded (not needed for history replay).
    """
    __tablename__ = "session_sse_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    event_json: Mapped[str] = mapped_column(Text)


class SnapshotModel(Base):
    """Session 状态快照，用于加速 resume 时的 event replay。"""
    __tablename__ = "snapshots"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), ForeignKey("sessions.id"), index=True)
    last_event_id: Mapped[str] = mapped_column(String(64))
    last_event_sequence: Mapped[int] = mapped_column(Integer)
    state_blob_json: Mapped[str] = mapped_column(Text)
    snapshot_reason: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AgentTemplateModel(Base):
    """Agent template 元数据。只存定位信息，不存 SOUL/ROLE 文本。

    template_dir 指向磁盘上的模板目录（含 SOUL.md）；
    DirAgentCapabilityProvider.get_template() 通过此路径按需读取文件。
    """
    __tablename__ = "agent_templates"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), index=True)
    version: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(Text, default="")
    template_dir: Mapped[str] = mapped_column(Text)   # 模板目录绝对路径
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
