"""register_session_from_db 从实时 DB 把单个会话装进内存 _sessions。"""
import pytest

from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.state_store import PostgresStateStore
from netlivecowork.persistence.postgres.models import SessionModel, TaskModel
from netlivecowork.api.models import session as sm

pytestmark = pytest.mark.asyncio


async def test_register_single_session(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'r.db').as_posix()}")
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go", goal="G", status="SUCCEEDED"))
            db.add(TaskModel(id="t1", session_id="s1", title="T1"))
    store = PostgresStateStore(factory)
    sm._sessions.clear()
    sm.set_state_store(store)      # ensure_hydrated 走模块级 store（生产里同一个对象）
    try:
        await sm.register_session_from_db(store, "s1")

        entry = sm._sessions["s1"]
        assert entry.session_id == "s1"
        assert entry.status == "SUCCEEDED"
        # children 按需装：登记完还是冷的，hydrate 之后才有 tasks。
        assert entry.tasks == {}
        await entry.ensure_hydrated()
        assert "t1" in entry.tasks
    finally:
        sm.set_state_store(None)


async def test_register_missing_is_noop(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'r2.db').as_posix()}")
    store = PostgresStateStore(factory)
    sm._sessions.clear()
    await sm.register_session_from_db(store, "nope")
    assert "nope" not in sm._sessions
