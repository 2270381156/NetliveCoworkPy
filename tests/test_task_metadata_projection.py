"""RECOGNIZE_INTENT_TOOL_CALL → tasks 表 title/description 投影。

root task 创建时 title 为空，元数据由 recognize_intent 并发补填；ProjectionUpdater
若不消费该事件，tasks 表永远空 title，导入/重启后任务面板即丢 name/description。
"""

from __future__ import annotations

from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import TaskModel
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater

_TS = datetime(2026, 7, 6, tzinfo=timezone.utc)


def _ev(type_: str, task_id: str | None = None, **payload) -> Event:
    return Event(id=f"evt_{type_}_{task_id}", run_id="r1", sequence=1, session_id="ses_1",
                 type=type_, timestamp=_TS, task_id=task_id, payload=payload)


async def _task_row(factory, task_id: str) -> TaskModel | None:
    async with factory() as db:
        return await db.get(TaskModel, task_id)


async def test_recognize_intent_tool_call_updates_task_row(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'meta.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(
        EventType.TASK_CREATED, task_id="tsk_1",
        task={"id": "tsk_1", "status": "ACTIVE", "title": "", "description": ""},
    ))
    await proj.on_event(_ev(
        EventType.RECOGNIZE_INTENT_TOOL_CALL, task_id="tsk_1",
        title="修复导入", description="导入后恢复 root task 元数据", session_goal="",
    ))

    row = await _task_row(factory, "tsk_1")
    assert row is not None
    assert row.title == "修复导入"
    assert row.description == "导入后恢复 root task 元数据"


async def test_recognize_intent_tool_call_empty_fields_do_not_clobber(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'meta2.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_ev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_ev(
        EventType.TASK_CREATED, task_id="tsk_1",
        task={"id": "tsk_1", "status": "ACTIVE", "title": "已有标题", "description": "已有描述"},
    ))
    await proj.on_event(_ev(
        EventType.RECOGNIZE_INTENT_TOOL_CALL, task_id="tsk_1",
        title="", description="", session_goal="",
    ))

    row = await _task_row(factory, "tsk_1")
    assert row is not None
    assert row.title == "已有标题"
    assert row.description == "已有描述"
