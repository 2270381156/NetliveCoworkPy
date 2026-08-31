"""重连/重启后 SSE 补发 waiting_input：PAUSED_HITL 会话的提问框不丢。

waiting_input 是瞬时控制事件,不进 history(_HISTORY_TYPES),且 init 把 waitingInput 清空 →
重连后前端提问框消失。sse_generator 在 status==PAUSED_HITL 时补发 waiting_input。

补发以 HitlManager 的 pending 真值合成（帧带 hitl_id）：旧版本落库的存量帧无 hitl_id,
原样重放会让前端去重键退化为 local:*,与 /hitl/pending 的 hit_* 键对不上 → 同一问题双卡。
内存无 pending（未 recover / 无 manager）时回退旧行为：重放最近一条存量帧。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ctx_weft.core.state.models import HitlRequest

from netlivecowork.api import deps
from netlivecowork.api.models.session import SessionEntry, _sessions, sse_generator


class _FakeHitl:
    def __init__(self, pending: list[HitlRequest]) -> None:
        self._pending = pending

    def list_pending(self, session_id: str | None = None) -> list[HitlRequest]:
        return [r for r in self._pending if session_id is None or r.session_id == session_id]


@pytest.fixture
def hitl_manager():
    """装/卸假 HitlManager;yield 出容器供测试填 pending。"""
    fake = _FakeHitl([])
    prev = deps.get_hitl_manager()
    deps.set_hitl_manager(fake)
    try:
        yield fake
    finally:
        deps.set_hitl_manager(prev)


def _entry(sid: str, status: str) -> SessionEntry:
    e = SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                     tenant_id="default", llm_model=None, llm_account=None)
    e.status = status
    return e


async def _collect_until(sid: str, needle: str, cap: int = 30) -> str:
    chunks: list[str] = []
    async for chunk in sse_generator(sid):
        chunks.append(chunk)
        if needle in chunk or len(chunks) >= cap:
            break
    return "".join(chunks)


async def test_paused_resends_waiting_input() -> None:
    sid = "s_wi"
    e = _entry(sid, "PAUSED_HITL")
    e.sse_events = [json.dumps({"type": "waiting_input", "input_type": "user_input", "prompt": "Which DB?"})]
    _sessions[sid] = e
    try:
        out = await _collect_until(sid, '"Which DB?"')
        assert "waiting_input" in out and "Which DB?" in out
    finally:
        _sessions.pop(sid, None)


async def test_paused_resend_synthesized_from_pending_truth(hitl_manager) -> None:
    """有 pending 真值时补发合成帧（带 hitl_id）,不重放缺 hitl_id 的存量旧帧。"""
    sid = "s_wi_truth"
    e = _entry(sid, "PAUSED_HITL")
    # 旧版本落库的存量帧：无 hitl_id
    e.sse_events = [json.dumps({"type": "waiting_input", "input_type": "user_input", "prompt": "legacy-frame?"})]
    _sessions[sid] = e
    hitl_manager._pending.append(HitlRequest(
        id="hit_truth1", form="question", session_id=sid, task_id="t1",
        capability_id="control:ask_user",
        questions=[{"question": "which topic granularity?"}],
    ))
    try:
        out = await _collect_until(sid, "hit_truth1")
        frames = [json.loads(c.split("data: ", 1)[1]) for c in out.split("\n\n") if c.startswith("data: ")]
        wi = [f for f in frames if f.get("type") == "waiting_input"]
        assert len(wi) == 1
        assert wi[0]["hitl_id"] == "hit_truth1"
        assert wi[0]["form"] == "question"
        assert wi[0]["questions"] == [{"question": "which topic granularity?"}]
        assert "legacy-frame?" not in out  # 存量旧帧不再原样重放
    finally:
        _sessions.pop(sid, None)


async def test_paused_resend_all_pending_sorted_skip_wait(hitl_manager) -> None:
    """多 pending 全量补发（created_at 升序）;form=wait 无面板,不补发。"""
    sid = "s_wi_multi"
    e = _entry(sid, "PAUSED_HITL")
    e.sse_events = []
    _sessions[sid] = e
    t1 = datetime(2026, 7, 1, tzinfo=timezone.utc)
    t2 = datetime(2026, 7, 2, tzinfo=timezone.utc)
    hitl_manager._pending.extend([
        HitlRequest(id="hit_b", form="approval", session_id=sid, task_id="t1",
                    capability_id="fs:write", arguments={"path": "x"}, created_at=t2),
        HitlRequest(id="hit_a", form="question", session_id=sid, task_id="t1",
                    capability_id="control:ask_user", created_at=t1),
        HitlRequest(id="hit_w", form="wait", session_id=sid, task_id="t1", created_at=t1),
        HitlRequest(id="hit_other", form="question", session_id="other", task_id="t9", created_at=t1),
    ])
    try:
        out = await _collect_until(sid, "hit_b")
        frames = [json.loads(c.split("data: ", 1)[1]) for c in out.split("\n\n") if c.startswith("data: ")]
        wi = [f for f in frames if f.get("type") == "waiting_input"]
        assert [f["hitl_id"] for f in wi] == ["hit_a", "hit_b"]
        assert wi[0]["kind"] == "input" and wi[1]["kind"] == "approval"
        assert wi[1]["arguments"] == {"path": "x"}
    finally:
        _sessions.pop(sid, None)


async def test_paused_resend_falls_back_to_legacy_frame(hitl_manager) -> None:
    """内存无 pending（如未 recover）→ 回退重放最近一条存量帧,提问框不丢。"""
    sid = "s_wi_fallback"
    e = _entry(sid, "PAUSED_HITL")
    e.sse_events = [json.dumps({"type": "waiting_input", "input_type": "user_input", "prompt": "legacy-only?"})]
    _sessions[sid] = e
    try:
        out = await _collect_until(sid, "legacy-only?")
        assert "waiting_input" in out and "legacy-only?" in out
    finally:
        _sessions.pop(sid, None)


async def test_running_does_not_resend_waiting_input() -> None:
    """非 PAUSED 不补发——避免复活已解决的旧提问框。"""
    sid = "s_run"
    e = _entry(sid, "RUNNING")
    e.sse_events = [json.dumps({"type": "waiting_input", "input_type": "user_input", "prompt": "old?"})]
    _sessions[sid] = e
    try:
        # 消费到 init+history+session_update 之后(用 session_update 作锚)再断言没有补发
        out = await _collect_until(sid, '"session_update"')
        # session_update 之后 RUNNING 不补发；history 也已过滤掉 waiting_input
        assert "waiting_input" not in out
    finally:
        _sessions.pop(sid, None)
