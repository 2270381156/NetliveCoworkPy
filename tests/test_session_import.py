"""import_session_db：导入 dump、id 重映射、写实时 DB；重复导入不撞主键。"""
import json

import pytest

from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import (
    SessionModel, TaskModel, EventModel, SessionSSEEventModel,
)
from netlivecowork.observability.session_import import (
    import_session_db, InvalidSessionDumpError,
)
from netlivecowork.observability.session_export import export_session_db

pytestmark = pytest.mark.asyncio


async def _make_dump(tmp_path) -> bytes:
    """造一个含 task + 内嵌 task id 的 sse 事件的源 DB，返回其文件字节。

    使用 export_session_db 产生真正的 dump 字节（sync 非 WAL SQLite），
    和生产流程一致：init_db 写数据 → export_session_db → bytes。
    直接读 aiosqlite WAL 模式文件字节会因 WAL 未 checkpoint 而丢失数据。
    """
    src = tmp_path / "src.db"
    factory = await init_db(f"sqlite:///{src.as_posix()}")
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go", goal="G", status="SUCCEEDED",
                                config_json='{"template_id": "tpl"}'))
            db.add(TaskModel(id="t1", session_id="s1", title="T1"))
            db.add(EventModel(id="e1", session_id="s1", task_id="t1",
                              type="TaskCreated", sequence=1,
                              payload_json=json.dumps({"task_id": "t1"})))
            db.add(SessionSSEEventModel(
                session_id="s1",
                event_json=json.dumps({"type": "task_created",
                                       "task": {"id": "t1", "session_id": "s1"}}),
            ))
    return await export_session_db("s1", factory)


async def test_import_rekeys_and_writes(tmp_path):
    data = await _make_dump(tmp_path)
    live = await init_db(f"sqlite:///{(tmp_path / 'live.db').as_posix()}")

    new_id = await import_session_db(data, live)

    assert new_id.startswith("imp_")
    async with live() as db:
        # 会话在新 id 下，原 id 不存在
        assert await db.get(SessionModel, new_id) is not None
        assert await db.get(SessionModel, "s1") is None
        # 一致性：tasks 表 id == sse event_json 里的 task id
        from sqlalchemy import select
        task = (await db.execute(select(TaskModel))).scalars().one()
        sse = (await db.execute(select(SessionSSEEventModel))).scalars().one()
        ev = json.loads(sse.event_json)
        assert ev["task"]["id"] == task.id
        assert task.id.startswith("imp_")
        # imported_from 记原始 id
        sess = await db.get(SessionModel, new_id)
        assert json.loads(sess.config_json)["imported_from"] == "s1"


async def test_reimport_twice_no_collision(tmp_path):
    data = await _make_dump(tmp_path)
    live = await init_db(f"sqlite:///{(tmp_path / 'live2.db').as_posix()}")

    id_a = await import_session_db(data, live)
    id_b = await import_session_db(data, live)   # 同一份字节再导一次

    assert id_a != id_b
    async with live() as db:
        from sqlalchemy import select, func
        n_sessions = (await db.execute(select(func.count()).select_from(SessionModel))).scalar()
        n_tasks = (await db.execute(select(func.count()).select_from(TaskModel))).scalar()
        assert n_sessions == 2
        assert n_tasks == 2


async def _make_ordered_dump(tmp_path) -> bytes:
    """5 条事件：旧 id 字典序 = 时间序（e1<…<e5），其中 e2/e3 同一微秒（撞车组）。"""
    from datetime import datetime, timezone
    src = tmp_path / "src_ord.db"
    factory = await init_db(f"sqlite:///{src.as_posix()}")
    t = lambda m, us=0: datetime(2026, 7, 3, 10, m, 0, us, tzinfo=timezone.utc)  # noqa: E731
    stamps = [t(0), t(1, 500), t(1, 500), t(2), t(3)]  # e2/e3 同微秒
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go"))
            for i, ts in enumerate(stamps, start=1):
                e = EventModel(id=f"e{i}", session_id="s1", type="TaskStarted",
                               sequence=i, payload_json=json.dumps({"n": i}))
                e.timestamp = ts
                db.add(e)
    return await export_session_db("s1", factory)


async def test_import_preserves_event_id_order(tmp_path):
    """重映射后 ORDER BY id 仍复原原始顺序（含同微秒撞车组）,且事件 id 用 evt_ 前缀
    （与续跑追加的新事件同前缀可比,时间轴衔接）;非事件 id 维持 imp_ 前缀。"""
    data = await _make_ordered_dump(tmp_path)
    live = await init_db(f"sqlite:///{(tmp_path / 'live_ord.db').as_posix()}")

    new_sid = await import_session_db(data, live)

    from sqlalchemy import select
    async with live() as db:
        rows = (await db.execute(
            select(EventModel).where(EventModel.session_id == new_sid)
            .order_by(EventModel.id))).scalars().all()
    assert [json.loads(r.payload_json)["n"] for r in rows] == [1, 2, 3, 4, 5]
    assert all(r.id.startswith("evt_") for r in rows)
    assert new_sid.startswith("imp_")
    # 新 id 的时间前缀应贴近原事件时刻（同为 2026-07-03 的 ULID 时间段）,而非导入时刻:
    # 续跑追加的新事件才能排在导入历史之后。用原始 e1 时刻构造的 ULID 做字典序参照。
    from datetime import datetime, timezone
    from ulid import ULID
    day_floor = f"evt_{ULID.from_datetime(datetime(2026, 7, 3, tzinfo=timezone.utc))}"
    day_ceil = f"evt_{ULID.from_datetime(datetime(2026, 7, 4, tzinfo=timezone.utc))}"
    assert all(day_floor <= r.id <= day_ceil for r in rows)


async def test_bad_input_raises(tmp_path):
    live = await init_db(f"sqlite:///{(tmp_path / 'live3.db').as_posix()}")
    with pytest.raises(InvalidSessionDumpError):
        await import_session_db(b"not a sqlite file", live)


async def test_import_accepts_gzip_and_raw(tmp_path):
    """导入既吃 gzip 产物,也吃旧的未压缩 sqlite 字节(向后兼容)。"""
    import gzip

    gz = await _make_dump(tmp_path)          # export_session_db 现在产 gzip
    assert gz[:2] == b"\x1f\x8b"
    raw = gzip.decompress(gz)                # 模拟旧的未压缩 dump

    live = await init_db(f"sqlite:///{(tmp_path / 'live_compat.db').as_posix()}")
    id_gz = await import_session_db(gz, live)
    id_raw = await import_session_db(raw, live)

    assert id_gz.startswith("imp_") and id_raw.startswith("imp_")
    async with live() as db:
        from sqlalchemy import select, func
        n = (await db.execute(select(func.count()).select_from(SessionModel))).scalar()
        assert n == 2   # 两次导入各落一行,不撞主键
