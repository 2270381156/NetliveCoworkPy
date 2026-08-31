"""session_notice 帧合成（spec 2026-07-15-session-notice-banner）：

FAILED/INTERRUPTED 的死因/成因经由持久化 SSE 帧直达前端底部框。
熔断 notice 在 FAILURE_THRESHOLD_HIT 处合成；其余 FAILED 在
SESSION_STATUS_CHANGED 处按 _last_task_failure 素材合成。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from netlivecowork.api.models.session import _HISTORY_TYPES, SessionEntry

_TS = datetime(2026, 6, 16, tzinfo=timezone.utc)


def _entry(sid: str) -> SessionEntry:
    return SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                        tenant_id="default", llm_model=None, llm_account=None)


def _ev(sid: str, type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}", run_id="r1", sequence=1,
                 session_id=sid, task_id=payload.pop("task_id", None), type=type_,
                 timestamp=_TS, payload=payload)


def _frames(result) -> list[dict]:
    """translate_event 返回 str | list[str] | None → 统一成 dict 列表。"""
    if result is None:
        return []
    items = result if isinstance(result, list) else [result]
    return [json.loads(x) for x in items]


def _notices(result) -> list[dict]:
    return [f for f in _frames(result) if f.get("type") == "session_notice"]


def test_observer_failure_notice_carries_verdict_summary() -> None:
    e = _entry("s1")
    e.translate_event(_ev("s1", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="观察者判定：输出缺少关键字段"))
    out = e.translate_event(_ev("s1", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    notices = _notices(out)
    assert len(notices) == 1
    n = notices[0]
    assert n["kind"] == "failed"
    assert n["reason_code"] == "TASK_FAILED_BY_OBSERVER"
    assert n["reason_text"] == "观察者判定：输出缺少关键字段"
    assert n["failures"] == []
    # session_update 照常在场
    assert any(f["type"] == "session_update" for f in _frames(out))


def test_threshold_notice_emitted_at_hit_not_at_status_change() -> None:
    e = _entry("s2")
    hit = e.translate_event(_ev(
        "s2", EventType.FAILURE_THRESHOLD_HIT,
        failure_counter=3, threshold=3,
        failures=[{"title": "抓取页面", "reason": "选择器失效"},
                  {"title": "解析数据", "reason": "格式不符"},
                  {"title": "重试抓取", "reason": "选择器仍失效"}]))
    notices = _notices(hit)
    assert len(notices) == 1
    n = notices[0]
    assert n["kind"] == "failed"
    assert n["reason_code"] == "TASK_FAILED_BY_THRESHOLD"
    assert "3" in n["reason_text"]
    assert len(n["failures"]) == 3
    assert n["failures"][0] == {"title": "抓取页面", "reason": "选择器失效"}
    # reason=failure_threshold 的 FAILED 不再重复合成
    out = e.translate_event(_ev("s2", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED", reason="failure_threshold"))
    assert _notices(out) == []
    assert any(f["type"] == "session_update" for f in _frames(out))


def test_task_finished_clears_failure_material() -> None:
    e = _entry("s3")
    e.translate_event(_ev("s3", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="第一次失败"))
    e.translate_event(_ev("s3", EventType.TASK_FINISHED, task_id="tsk_1"))
    out = e.translate_event(_ev("s3", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "SESSION_FAILED"
    assert n["reason_text"] == "会话失败"


def test_threshold_code_does_not_overwrite_material() -> None:
    e = _entry("s4")
    e.translate_event(_ev("s4", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="真实死因"))
    e.translate_event(_ev("s4", EventType.TASK_FAILED, task_id="tsk_root",
                          error_code="TASK_FAILED_BY_THRESHOLD",
                          error_message="Session failure threshold reached (3)."))
    assert e._last_task_failure == {"code": "TASK_FAILED_BY_OBSERVER",
                                    "message": "真实死因"}


def test_observer_fail_without_reason_gets_fixed_hint() -> None:
    """observer 判死但没给 task_failure_reason（core 发空 error_message）→ 不再显示过程
    复述/裸「会话失败」，改固定提示：agent 判定失败 + 请查看执行过程决定是否继续。"""
    from netlivecowork.api.models.session import _OBSERVER_FAIL_FALLBACK
    e = _entry("s10")
    e.translate_event(_ev("s10", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message=""))
    out = e.translate_event(_ev("s10", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "TASK_FAILED_BY_OBSERVER"
    assert n["reason_text"] == _OBSERVER_FAIL_FALLBACK


def test_retry_exhausted_notice_composes_blocker() -> None:
    """retry 耗尽熔断（TASK_FAILED_RETRY_EXHAUSTED）：文案 = 重试上限说明 + 最后一轮
    受阻原因（core 从最后一次 retry 判决的 task_failure_reason 带出）。"""
    e = _entry("s11")
    e.translate_event(_ev("s11", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_RETRY_EXHAUSTED",
                          error_message="登录页有人机校验，自动化被拦",
                          retry_count=3))
    out = e.translate_event(_ev("s11", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "TASK_FAILED_RETRY_EXHAUSTED"
    assert "重试 3 次" in n["reason_text"]
    assert "登录页有人机校验，自动化被拦" in n["reason_text"]


def test_retry_exhausted_notice_without_blocker_gets_hint() -> None:
    """耗尽但无受阻原因（旧 core / 机械退出轮）→ 上限说明 + 引导回看执行过程。"""
    e = _entry("s12")
    e.translate_event(_ev("s12", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_RETRY_EXHAUSTED",
                          error_message="", retry_count=3))
    out = e.translate_event(_ev("s12", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "TASK_FAILED_RETRY_EXHAUSTED"
    assert "重试 3 次" in n["reason_text"]
    assert "执行过程" in n["reason_text"]


def test_generic_fallback_without_material() -> None:
    e = _entry("s5")
    out = e.translate_event(_ev("s5", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "SESSION_FAILED"


def test_interrupted_notice_passes_reason_code() -> None:
    e = _entry("s6")
    out = e.translate_event(_ev("s6", EventType.SESSION_STATUS_CHANGED,
                                new_status="INTERRUPTED",
                                reason="CONTEXT_OVERFLOW"))
    n = _notices(out)[0]
    assert n["kind"] == "interrupted"
    assert n["reason_code"] == "CONTEXT_OVERFLOW"
    # session_update 的 interrupt_reason 老契约不回归
    upd = [f for f in _frames(out) if f["type"] == "session_update"][0]
    assert upd["interrupt_reason"] == "CONTEXT_OVERFLOW"


def test_non_terminal_status_change_has_no_notice() -> None:
    e = _entry("s7")
    out = e.translate_event(_ev("s7", EventType.SESSION_STATUS_CHANGED,
                                new_status="RUNNING"))
    assert _notices(out) == []


def test_session_notice_in_history_types() -> None:
    assert "session_notice" in _HISTORY_TYPES


def test_task_failed_bubble_falls_back_to_observer_summary() -> None:
    """observer 判死时 run_error 为 None → 气泡不再是通用 'Task failed'，
    回落到 TASK_FAILED 暂存的判决摘要（持久化帧由此跨重启保持精确）。"""
    e = _entry("s8")
    e.translate_event(_ev("s8", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="观察者判定：结果为空"))
    out = e.translate_event(_ev("s8", EventType.RUN_FINISHED, task_id="tsk_1",
                                final_status="FAILED", will_retry=False,
                                error=None, error_type=None))
    bubble = [f for f in _frames(out) if f.get("type") == "task_failed"][0]
    assert bubble["error"] == "观察者判定：结果为空"


def test_task_failed_bubble_prefers_run_error_when_present() -> None:
    e = _entry("s9")
    e.translate_event(_ev("s9", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="旧素材"))
    out = e.translate_event(_ev("s9", EventType.RUN_FINISHED, task_id="tsk_1",
                                final_status="FAILED", will_retry=False,
                                error="RuntimeError: boom", error_type="RuntimeError"))
    bubble = [f for f in _frames(out) if f.get("type") == "task_failed"][0]
    assert bubble["error"] == "RuntimeError: boom"


# ── restore 回填（Task 2）──────────────────────────────────────────────────────

from netlivecowork.api.models.session import _scan_history


def _last_task_failure_from(events):
    """单遍扫描里的失败气泡分量（原 _last_task_failure_from 已折进 _scan_history）。"""
    return _scan_history(events)[1]


def test_backfill_takes_last_terminal_task_failed() -> None:
    events = [
        json.dumps({"type": "message", "role": "user", "content": "hi"}),
        json.dumps({"type": "task_failed", "error": "第一次失败", "error_type": "",
                    "will_retry": False, "created_at": "t1"}),
        json.dumps({"type": "task_failed", "error": "致败原因", "error_type": "",
                    "will_retry": False, "created_at": "t2"}),
    ]
    assert _last_task_failure_from(events) == {"code": "TASK_FAILED",
                                               "message": "致败原因"}


def test_backfill_skips_retry_and_recoverable_bubbles() -> None:
    events = [
        json.dumps({"type": "task_failed", "error": "终态失败", "error_type": "",
                    "will_retry": False, "created_at": "t1"}),
        json.dumps({"type": "task_failed", "error": "重试中", "error_type": "",
                    "will_retry": True, "created_at": "t2"}),
        json.dumps({"type": "task_failed", "error": "崩溃挂起", "error_type": "LLMCallError",
                    "will_retry": False, "recoverable": True, "created_at": "t3"}),
    ]
    assert _last_task_failure_from(events) == {"code": "TASK_FAILED",
                                               "message": "终态失败"}


def test_backfill_none_without_failures() -> None:
    events = [json.dumps({"type": "message", "role": "user", "content": "hi"})]
    assert _last_task_failure_from(events) is None
    assert _last_task_failure_from([]) is None


def test_backfill_uses_error_type_as_code() -> None:
    events = [json.dumps({"type": "task_failed", "error": "boom",
                          "error_type": "RuntimeError",
                          "will_retry": False, "created_at": "t1"})]
    assert _last_task_failure_from(events) == {"code": "RuntimeError",
                                               "message": "boom"}
