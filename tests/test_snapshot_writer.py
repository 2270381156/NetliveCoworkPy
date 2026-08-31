"""SnapshotWriter 行为测试：会话存活期间定期写快照 + 结束时收尾。

关键回归点：崩溃恢复针对的是**未结束**的 session，因此快照必须在 RunFinished
边界定期写出，而不能只在 SessionFinished 写——否则恢复时无快照可用，只能全量回放。
"""

from __future__ import annotations

from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from ctx_weft.core.state.event_store import InMemoryEventStore

from netlivecowork.persistence.snapshot_writer import SnapshotWriter


def _ev(seq: int, type_: str, **payload) -> Event:
    task_id = payload.pop("task_id", None)
    return Event(
        id=f"evt_{seq:04d}",
        run_id="run_1",
        sequence=seq,
        session_id="s1",
        type=type_,
        timestamp=datetime(2026, 6, 5, tzinfo=timezone.utc),
        task_id=task_id,
        payload=payload,
    )


async def _feed(store: InMemoryEventStore, writer: SnapshotWriter, events: list[Event]) -> None:
    """模拟 EventBus：先持久化（EventPersister 角色），再交给 SnapshotWriter。"""
    for ev in events:
        await store.append(ev)
        await writer.on_event(ev)


def _bootstrap() -> list[Event]:
    return [
        _ev(1, EventType.SESSION_CREATED, user_prompt="go",
            template_id="tmpl_a", root_agent_id="agt_root"),
        _ev(2, EventType.TASK_CREATED, task={
            "id": "tsk_1", "status": "PENDING", "assigned_agent_id": "agt_root",
        }),
        _ev(3, EventType.TASK_STARTED, task_id="tsk_1", assigned_agent_id="agt_root"),
    ]


async def test_periodic_snapshot_written_before_session_finishes() -> None:
    store = InMemoryEventStore()
    writer = SnapshotWriter(store, every_n_events=3)

    events = _bootstrap()
    # 第 4 条触达阈值（累计 4 ≥ 3）且为 RunFinished → 应落快照。
    events.append(_ev(4, EventType.RUN_FINISHED, final_status="FINISHED"))

    await _feed(store, writer, events)

    snap = await store.load_latest_snapshot("s1")
    assert snap is not None, "未结束的 session 也必须有可用快照（崩溃恢复前提）"
    assert snap.snapshot_reason == "periodic"
    assert snap.last_event_id == "evt_0004"
    # 快照内含已 reduce 的投影，恢复时无需全量回放
    assert "tsk_1" in snap.state_blob["tasks"]


async def test_run_finished_below_threshold_does_not_snapshot() -> None:
    store = InMemoryEventStore()
    writer = SnapshotWriter(store, every_n_events=50)

    events = _bootstrap()
    events.append(_ev(4, EventType.RUN_FINISHED, final_status="FINISHED"))
    await _feed(store, writer, events)

    # 累计事件 < 阈值 → 不写快照，避免在 loop 热路径上频繁落盘
    assert await store.load_latest_snapshot("s1") is None


async def test_session_finished_always_snapshots() -> None:
    store = InMemoryEventStore()
    writer = SnapshotWriter(store, every_n_events=999)

    events = _bootstrap()
    events.append(_ev(4, EventType.SESSION_FINISHED, final_status="SUCCEEDED"))
    await _feed(store, writer, events)

    snap = await store.load_latest_snapshot("s1")
    assert snap is not None and snap.snapshot_reason == "session_finished"


async def test_counter_resets_after_snapshot() -> None:
    store = InMemoryEventStore()
    writer = SnapshotWriter(store, every_n_events=2)

    # 第 2 条 RunFinished 触发首张快照
    await _feed(store, writer, [
        _ev(1, EventType.SESSION_CREATED, template_id="t", root_agent_id="a"),
        _ev(2, EventType.RUN_FINISHED, final_status="FINISHED"),
    ])
    first = await store.load_latest_snapshot("s1")
    assert first is not None and first.last_event_id == "evt_0002"

    # 计数已归零：再来一条 RunFinished（累计 1 < 2）不应再写
    await _feed(store, writer, [_ev(3, EventType.RUN_FINISHED, final_status="FINISHED")])
    assert (await store.load_latest_snapshot("s1")).last_event_id == "evt_0002"

    # 第 4 条使累计达 2 → 写第二张
    await _feed(store, writer, [_ev(4, EventType.RUN_FINISHED, final_status="FINISHED")])
    assert (await store.load_latest_snapshot("s1")).last_event_id == "evt_0004"


# ── PostgresEventStore: 旧快照清理（SQLite 后端跑） ────────────────────────────


async def test_postgres_snapshot_prune_keeps_latest_n(tmp_path) -> None:
    from sqlalchemy import func, select

    from netlivecowork.persistence.postgres import init_db
    from netlivecowork.persistence.postgres.event_store import PostgresEventStore
    from netlivecowork.persistence.postgres.models import SessionModel, SnapshotModel
    from ctx_weft.core.state.event_store import RunSnapshot
    from ctx_weft.core.utils import generate_id, now_utc

    factory = await init_db(f"sqlite:///{(tmp_path / 'snap.db').as_posix()}")
    store = PostgresEventStore(factory, keep_snapshots=2)

    # SnapshotModel.session_id 有 FK 到 sessions，先插一行 session。
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go"))

    # 顺序写 5 张快照；id 用 ULID（时间可排序），故第 5 张最新。
    snap_ids = []
    for i in range(1, 6):
        sid = generate_id("snp")
        snap_ids.append(sid)
        await store.save_snapshot(RunSnapshot(
            id=sid, run_id="run_1", session_id="s1",
            last_event_id=f"evt_{i:04d}", last_event_sequence=i,
            state_blob={"i": i}, snapshot_reason="periodic", snapshot_at=now_utc(),
        ))

    async with factory() as db:
        total = (await db.execute(
            select(func.count()).select_from(SnapshotModel)
            .where(SnapshotModel.session_id == "s1")
        )).scalar_one()
        remaining = set((await db.execute(
            select(SnapshotModel.id).where(SnapshotModel.session_id == "s1")
        )).scalars().all())

    assert total == 2, "应只保留最新 keep_snapshots 张"
    assert remaining == set(snap_ids[-2:]), "保留的必须是最新的两张"

    # load_latest_snapshot 仍取到最新一张
    latest = await store.load_latest_snapshot("s1")
    assert latest is not None and latest.id == snap_ids[-1]
