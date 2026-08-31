"""failure_counter 真折叠（Task 12，与 core reducer 同义）：

TASK_FAILED（非熔断聚合码）+1；TASK_FINISHED 清零；TASK_FAILED_BY_THRESHOLD 不计；
FAILURE_THRESHOLD_HIT 不再驱动计数（改由 TASK_FAILED/TASK_FINISHED 承担）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.api.models.session import SessionEntry
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import SessionModel
from netlivecowork.persistence.postgres.projection_updater import ProjectionUpdater

_TS = datetime(2026, 6, 16, tzinfo=timezone.utc)


def _entry(sid: str) -> SessionEntry:
    return SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                        tenant_id="default", llm_model=None, llm_account=None)


def _ev(sid: str, type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}_{payload.get('_uid', '')}", run_id="r1", sequence=1,
                 session_id=sid, task_id=payload.pop("task_id", None), type=type_,
                 timestamp=_TS, payload=payload)


def test_task_failed_increments_counter_twice() -> None:
    e = _entry("s1")
    e.translate_event(_ev("s1", EventType.TASK_FAILED, error="boom"))
    assert e.failure_counter == 1
    e.translate_event(_ev("s1", EventType.TASK_FAILED, error="boom again"))
    assert e.failure_counter == 2


def test_task_finished_resets_counter() -> None:
    e = _entry("s2")
    e.translate_event(_ev("s2", EventType.TASK_FAILED, error="boom"))
    assert e.failure_counter == 1
    e.translate_event(_ev("s2", EventType.TASK_FINISHED))
    assert e.failure_counter == 0


def test_task_failed_by_threshold_does_not_count() -> None:
    """熔断补标的聚合失败（root 被判 FAILED）不是「新的一次失败」，不计数。"""
    e = _entry("s3")
    e.translate_event(_ev("s3", EventType.TASK_FAILED, error="N consecutive failures",
                          error_code="TASK_FAILED_BY_THRESHOLD"))
    assert e.failure_counter == 0


def test_failure_threshold_hit_no_longer_drives_counter() -> None:
    """FAILURE_THRESHOLD_HIT 只是通知事件，计数已在此前的 TASK_FAILED 里折叠过；
    自身不应再额外 +1（否则会与 TASK_FAILED 重复计数）。"""
    e = _entry("s4")
    e.translate_event(_ev("s4", EventType.TASK_FAILED, error="boom"))
    assert e.failure_counter == 1
    e.translate_event(_ev("s4", EventType.FAILURE_THRESHOLD_HIT,
                          failures=[{"title": "t", "reason": "boom"}]))
    assert e.failure_counter == 1


# ── postgres 投影层（sqlite 驱动的同款 ProjectionUpdater）──────────────────────

def _pev(type_: str, task_id: str | None = None, **payload) -> Event:
    return Event(id=f"evt_{type_}_{task_id}", run_id="r1", sequence=1, session_id="ses_1",
                 type=type_, timestamp=_TS, task_id=task_id, payload=payload)


async def _session_row(factory, session_id: str) -> SessionModel | None:
    async with factory() as db:
        return await db.get(SessionModel, session_id)


async def test_projection_updater_folds_failure_counter(tmp_path) -> None:
    """TASK_FAILED +1 x2 → FINISHED 清零；THRESHOLD 码与 FAILURE_THRESHOLD_HIT 均不计。"""
    factory = await init_db(f"sqlite:///{(tmp_path / 'fc.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_pev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_pev(EventType.TASK_CREATED, task_id="tsk_1",
                              task={"id": "tsk_1", "status": "ACTIVE"}))

    await proj.on_event(_pev(EventType.TASK_FAILED, task_id="tsk_1", error="boom"))
    row = await _session_row(factory, "ses_1")
    assert row.failure_counter == 1

    await proj.on_event(_pev(EventType.TASK_FAILED, task_id="tsk_1", error="boom again"))
    row = await _session_row(factory, "ses_1")
    assert row.failure_counter == 2

    # 熔断补标的聚合失败不计数
    await proj.on_event(_pev(EventType.TASK_FAILED, task_id="tsk_1",
                              error="N consecutive failures",
                              error_code="TASK_FAILED_BY_THRESHOLD"))
    row = await _session_row(factory, "ses_1")
    assert row.failure_counter == 2

    # FAILURE_THRESHOLD_HIT 不再驱动计数
    await proj.on_event(_pev(EventType.FAILURE_THRESHOLD_HIT,
                              failures=[{"title": "t", "reason": "boom"}]))
    row = await _session_row(factory, "ses_1")
    assert row.failure_counter == 2

    await proj.on_event(_pev(EventType.TASK_FINISHED, task_id="tsk_1"))
    row = await _session_row(factory, "ses_1")
    assert row.failure_counter == 0


# ── RUN_CANCELED 不得覆盖已落的终态（C1）──────────────────────────────────────
# 熔断 trip 会协作取消在途兄弟 run；其 RUN_CANCELED 落在 SESSION_FINISHED(FAILED) 之后，
# 若无条件置 CANCELED 会把熔断终态盖掉。真用户取消不受影响：彼时会话仍非终态。

async def test_run_canceled_does_not_clobber_failed_from_threshold(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'rc1.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_pev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    await proj.on_event(_pev(EventType.SESSION_STATUS_CHANGED, new_status="FAILED"))
    await proj.on_event(_pev(EventType.SESSION_FINISHED, final_status="FAILED"))
    row = await _session_row(factory, "ses_1")
    assert row.status == "FAILED"

    # 迟到的兄弟 run 取消事件不得盖掉已落的 FAILED 终态
    await proj.on_event(_pev(EventType.RUN_CANCELED))
    row = await _session_row(factory, "ses_1")
    assert row.status == "FAILED"


async def test_run_canceled_still_cancels_running_session(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'rc2.db').as_posix()}")
    proj = ProjectionUpdater(factory)

    await proj.on_event(_pev(EventType.SESSION_CREATED, template_id="tpl", root_agent_id="agt"))
    row = await _session_row(factory, "ses_1")
    assert row.status == "RUNNING"

    # 真用户取消：会话仍处非终态时，RUN_CANCELED 正常生效
    await proj.on_event(_pev(EventType.RUN_CANCELED))
    row = await _session_row(factory, "ses_1")
    assert row.status == "CANCELED"
