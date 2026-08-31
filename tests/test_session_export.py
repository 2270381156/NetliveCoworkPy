"""export_session_db 只导出目标会话的行,且 schema 完整。"""
import gzip
import sqlite3

import pytest

from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import (
    SessionModel, TaskModel, EventModel, SnapshotModel,
)
from netlivecowork.observability.session_export import (
    export_session_db, SessionNotFoundError,
)

pytestmark = pytest.mark.asyncio


async def _seed(factory):
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go"))
            db.add(SessionModel(id="s2", user_prompt="other"))
            db.add(TaskModel(id="t1", session_id="s1"))
            db.add(TaskModel(id="t2", session_id="s2"))
            db.add(EventModel(id="e1", session_id="s1", type="StepStarted", sequence=1))
            db.add(EventModel(id="e2", session_id="s2", type="StepStarted", sequence=1))
            db.add(SnapshotModel(id="snp1", session_id="s1", last_event_id="e1",
                                 last_event_sequence=1, state_blob_json="{}"))


async def test_export_contains_only_target_session(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'src.db').as_posix()}")
    await _seed(factory)

    data = await export_session_db("s1", factory)
    # 产物是 gzip 整包（未压缩 JSON 文本冗余大 → 压缩存储）。
    assert data[:2] == b"\x1f\x8b"
    out = tmp_path / "out.sqlite"
    out.write_bytes(gzip.decompress(data))

    conn = sqlite3.connect(str(out))
    try:
        assert conn.execute("select id from sessions").fetchall() == [("s1",)]
        assert conn.execute("select id from tasks").fetchall() == [("t1",)]
        assert {r[0] for r in conn.execute("select id from events")} == {"e1"}
        assert conn.execute("select count(*) from snapshots").fetchone()[0] == 1
        # 全局表 agent_templates 建了 schema 但不灌数据
        assert conn.execute("select count(*) from agent_templates").fetchone()[0] == 0
        names = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
        assert {"sessions", "tasks", "events", "memory_events",
                "memory_subscriptions", "session_sse_events", "snapshots"} <= names
    finally:
        conn.close()


async def test_export_missing_session_raises(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'src2.db').as_posix()}")
    with pytest.raises(SessionNotFoundError):
        await export_session_db("nope", factory)
