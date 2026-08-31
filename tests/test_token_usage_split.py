"""token 统计口径：input 累计实际输入（usage.input_tokens），cache 拆分键进 token_update。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from ctx_weft.core.events import EventType
from netlivecowork.api.models.session import SessionEntry


@pytest.fixture(autouse=True)
def _mute_cloud_report(monkeypatch):
    """LLM_RESPONSE_FINISHED 路径会同步调云端上报（写 spool 文件）——测试统一静音；
    Task 9 的用例在测试体内再 setattr 覆盖为记录桩（后设者胜）。"""
    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage",
        lambda **kw: None)


def _entry() -> SessionEntry:
    return SessionEntry(
        session_id="s1", template_id="tpl", user_prompt="hi",
        tenant_id="default", llm_model="m", llm_account="acc",
    )


def _finished_ev(usage: dict) -> SimpleNamespace:
    return SimpleNamespace(
        type=EventType.LLM_RESPONSE_FINISHED,
        payload={"request_id": "req1", "content": "hi", "reasoning": "",
                 "tool_calls": [], "usage": usage, "finish_reason": "stop", "turn": 0},
        timestamp=datetime.now(timezone.utc),
        run_id="r1", task_id="tsk_1", agent_id="agt_1",
    )


_SPLIT_USAGE = {
    "prompt_tokens": 127, "completion_tokens": 5, "total_tokens": 132,
    "cache_read_tokens": 100, "cache_write_tokens": 20, "input_tokens": 7,
    "reasoning_tokens": 0,
}


async def test_input_accumulates_actual_input_tokens() -> None:
    e = _entry()
    e.translate_event(_finished_ev(_SPLIT_USAGE))
    assert e.input_tokens == 7          # 实际输入，不再是 prompt 总输入
    assert e.output_tokens == 5
    assert e.cache_read_used == 100
    assert e.cache_write_used == 20
    assert e.context_tokens == 127      # 当前窗口仍取 prompt 总输入


async def test_legacy_usage_falls_back_to_prompt_tokens() -> None:
    # replay 旧事件：usage 无 input_tokens 键 → 回退 prompt_tokens（旧口径全额实际输入）
    e = _entry()
    e.translate_event(_finished_ev(
        {"prompt_tokens": 40, "completion_tokens": 3, "total_tokens": 43}))
    assert e.input_tokens == 40
    assert e.cache_read_used == 0 and e.cache_write_used == 0


async def test_token_update_frame_carries_cache_keys() -> None:
    e = _entry()
    e.translate_event(_finished_ev(_SPLIT_USAGE))
    await asyncio.sleep(0)              # token_update 经 ensure_future 进 sse_events
    frames = [json.loads(s) for s in e.sse_events]
    tu = [f for f in frames if f.get("type") == "token_update"]
    assert tu
    assert tu[0]["input_tokens_used"] == 7
    assert tu[0]["cache_read_tokens_used"] == 100
    assert tu[0]["cache_write_tokens_used"] == 20
    assert tu[0]["context_tokens"] == 127


async def test_snapshot_and_session_update_carry_cache_keys() -> None:
    e = _entry()
    e.translate_event(_finished_ev(_SPLIT_USAGE))
    d = e.to_dict()
    assert d["cache_read_tokens_used"] == 100
    assert d["cache_write_tokens_used"] == 20
    su = json.loads(e._session_update_json("RUNNING"))
    assert su["cache_read_tokens_used"] == 100
    assert su["cache_write_tokens_used"] == 20


async def test_cloud_report_uses_actual_input(monkeypatch) -> None:
    # spool 的 input_tokens 切换为实际输入口径；不加拆分键（spec §8.2）
    calls: list[dict] = []

    def _fake(**kw):
        calls.append(kw)

    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage", _fake)
    e = _entry()
    e.translate_event(_finished_ev(_SPLIT_USAGE))
    assert calls
    assert calls[0]["prompt_tokens"] == 7        # 实际输入，不再是 127
    assert calls[0]["completion_tokens"] == 5


async def test_cloud_report_legacy_fallback(monkeypatch) -> None:
    calls: list[dict] = []

    def _fake(**kw):
        calls.append(kw)

    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage", _fake)
    e = _entry()
    e.translate_event(_finished_ev(
        {"prompt_tokens": 40, "completion_tokens": 3, "total_tokens": 43}))
    assert calls and calls[0]["prompt_tokens"] == 40

def _finished_ev_with_identity(usage: dict, *, llm_model: str, llm_account: str) -> SimpleNamespace:
    ev = _finished_ev(usage)
    ev.payload["llm_model"] = llm_model
    ev.payload["llm_account"] = llm_account
    return ev


async def test_cloud_report_prefers_event_identity(monkeypatch) -> None:
    # 事件自带「该次调用实际使用的账号/模型」→ 上报按它计账，
    # 不再用响应处理时的「当前会话账号」（切换账号存在竞态、会标错账）。
    calls: list[dict] = []

    def _fake(**kw):
        calls.append(kw)

    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage", _fake)
    e = _entry()
    e.translate_event(_finished_ev_with_identity(
        _SPLIT_USAGE, llm_model="deepseek-v4-pro", llm_account="deepseek-rj"))
    assert calls
    assert calls[0]["llm_account"] == "deepseek-rj"
    assert calls[0]["llm_model"] == "deepseek-v4-pro"


async def test_cloud_report_treats_mock_model_as_absent(monkeypatch) -> None:
    # 存量事件（2026-07-16 core 事件携带 identity 起，至回填修复前）payload 写死了
    # "mock" 哨兵——truthy 会压过本来正确的回退解析，须视同缺失。
    calls: list[dict] = []

    def _fake(**kw):
        calls.append(kw)

    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage", _fake)
    e = _entry()
    _resolved_account, resolved_model = e._resolve_reported_llm()
    e.translate_event(_finished_ev_with_identity(
        _SPLIT_USAGE, llm_model="mock", llm_account=""))
    assert calls
    assert calls[0]["llm_model"] == resolved_model
    assert calls[0]["llm_model"] != "mock"


async def test_cloud_report_identity_falls_back_to_resolver(monkeypatch) -> None:
    # replay 旧事件（payload 无 llm_model/llm_account 键）→ 维持既有 resolver 行为
    calls: list[dict] = []

    def _fake(**kw):
        calls.append(kw)

    monkeypatch.setattr(
        "netlivecowork.observability.token_usage_subscriber.report_token_usage", _fake)
    e = _entry()
    resolved_account, resolved_model = e._resolve_reported_llm()
    e.translate_event(_finished_ev(_SPLIT_USAGE))
    assert calls
    assert calls[0]["llm_account"] == resolved_account
    assert calls[0]["llm_model"] == resolved_model
