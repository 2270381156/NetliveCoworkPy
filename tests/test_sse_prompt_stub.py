"""调试前端(frontend/)的 prompt 存根模式：?prompts=stub。

llm_prompt/daemon_prompt 是每轮发给模型的完整 prompt，随对话平方级膨胀——实测最大的
dev 会话 66MB 里 62.8MB(95%)是它。首连时后端把整段历史拼成**一个** SSE frame 下发，
浏览器要缓冲 + JSON.parse 一个 66MB 的串 → 长会话直接卡死/空白。

桌面端用 ?lean=1 整类剔除，但调试前端靠 prompt 卡片吃饭，不能砍。折中：?prompts=stub
只留头部元信息（source/round_label/task_id/agent_id/tool_names/created_at）+ event_index，
去掉 system_prompt/messages；卡片展开时按 event_index 单条拉全文。
"""

from __future__ import annotations

import json

import pytest

from fastapi import HTTPException

import netlivecowork.api.sessions as sessions_mod
from netlivecowork.api.models.session import SessionEntry, _sessions, sse_generator

pytestmark = pytest.mark.asyncio


BIG = "x" * 5000


def _prompt_event(kind: str = "llm_prompt") -> dict:
    return {
        "type": kind,
        "source": "actor",
        "round_label": "round 3",
        "task_id": "tsk_1",
        "agent_id": "ag_1",
        "system_prompt": BIG,
        "messages": [{"role": "user", "content": BIG}],
        "tool_names": ["read", "write"],
        "created_at": "2026-01-01T00:00:00Z",
    }


def _entry(sid: str) -> SessionEntry:
    e = SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                     tenant_id="default", llm_model=None, llm_account=None)
    e.status = "COMPLETED"
    e.sse_events = [
        json.dumps({"type": "message", "role": "user", "content": "hi"}),
        json.dumps(_prompt_event("llm_prompt")),
        json.dumps(_prompt_event("daemon_prompt")),
    ]
    e.sse_finished = True
    return e


async def _history(sid: str, **kw) -> dict:
    """跑到 history 帧为止，返回解析后的 history 事件列表。"""
    async for chunk in sse_generator(sid, **kw):
        if '"type": "history"' in chunk:
            payload = chunk[len("data: "):].strip()
            return json.loads(payload)
    raise AssertionError("no history frame")


@pytest.fixture
def session():
    sid = "s_stub"
    _sessions[sid] = _entry(sid)
    try:
        yield sid
    finally:
        _sessions.pop(sid, None)


async def test_stub_strips_prompt_body_and_keeps_header(session):
    events = (await _history(session, prompts="stub"))["events"]
    prompts = [e for e in events if e["type"] in ("llm_prompt", "daemon_prompt")]
    assert len(prompts) == 2
    for p in prompts:
        assert p["stub"] is True
        assert "system_prompt" not in p and "messages" not in p
        # 头部元信息保留，卡片折叠态照常显示
        assert p["round_label"] == "round 3"
        assert p["task_id"] == "tsk_1"
        assert p["agent_id"] == "ag_1"
        assert p["tool_names"] == ["read", "write"]
        assert p["source"] == "actor"
        assert p["created_at"] == "2026-01-01T00:00:00Z"
    # event_index 是 sse_events 下标（与增量补发的 `id:` 同口径），拿它单条回取
    assert [p["event_index"] for p in prompts] == [1, 2]
    # 非 prompt 帧不受影响
    assert any(e["type"] == "message" for e in events)


async def test_stub_actually_shrinks_payload(session):
    full = json.dumps(await _history(session))
    stub = json.dumps(await _history(session, prompts="stub"))
    assert len(stub) * 10 < len(full)


async def test_default_still_sends_full_prompts(session):
    events = (await _history(session))["events"]
    p = next(e for e in events if e["type"] == "llm_prompt")
    assert p["system_prompt"] == BIG
    assert "stub" not in p


async def test_lean_still_drops_prompts_entirely(session):
    events = (await _history(session, lean=True, prompts="stub"))["events"]
    assert not [e for e in events if e["type"] in ("llm_prompt", "daemon_prompt")]


async def test_get_event_returns_raw_frame(session):
    resp = await sessions_mod.get_session_event(session, 1)
    body = json.loads(resp.body)
    assert body["type"] == "llm_prompt"
    assert body["system_prompt"] == BIG
    assert body["messages"][0]["content"] == BIG


async def test_get_event_404_on_bad_index(session):
    for bad in (-1, 99):
        with pytest.raises(HTTPException) as ei:
            await sessions_mod.get_session_event(session, bad)
        assert ei.value.status_code == 404


async def test_get_event_404_on_unknown_session():
    with pytest.raises(HTTPException) as ei:
        await sessions_mod.get_session_event("nope", 0)
    assert ei.value.status_code == 404
