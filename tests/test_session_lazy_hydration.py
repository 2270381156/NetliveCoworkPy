"""启动只灌会话元数据，tasks / sse_events 推迟到真用时再装。

原状：load_sessions_from_db 对**每个**会话都跑 _load_entry_children，把全部 SSE 历史
读回内存并整体 json.loads 两遍（_count_user_turns 正序 + _last_task_failure_from 逆序）。
成本是 O(全部会话的历史总字节)，本机 80 会话 / 177MB 要 1.9s，会话再多就把 Electron
那 30s 启动预算吃光。而列表页只用 to_dict()，一个字段都不来自 children。

改法：entry 冷装载时不带 children，由 ensure_hydrated() 按需补。闸门下沉到
_append_json / append_event 内部，使「往未 hydrate 的 entry 追加」结构上不可能发生——
否则新帧会落在空 list 的 0 号位，既丢历史又让 SSE 的 `id:`（就是 list 下标，见
sse_generator）与前端 Last-Event-ID 续点错位。
"""

from __future__ import annotations

import asyncio
import json

import pytest

from netlivecowork.api.models.session import (
    SessionEntry,
    _sessions,
    load_sessions_from_db,
    set_state_store,
    sse_generator,
)
from netlivecowork.persistence.postgres.state_store import SessionRecord


def _record(sid: str) -> SessionRecord:
    return SessionRecord(
        id=sid, tenant_id="default", user_prompt="hi", status="SUCCEEDED", goal="g",
        root_agent_id="ag_1", llm_provider=None, llm_model=None,
        token_budget=1000, failure_counter=0,
    )


def _msg(role: str, text: str) -> str:
    return json.dumps({"type": "message", "role": role, "content": text})


class _CountingStore:
    """记录 children 读取次数的假 state store。"""

    def __init__(self, sessions: dict[str, list[str]]) -> None:
        self._sessions = sessions
        self.load_tasks_calls: list[str] = []
        self.load_sse_calls: list[str] = []
        self.appended: list[tuple[str, str]] = []

    async def list_sessions(self) -> list[SessionRecord]:
        return [_record(sid) for sid in self._sessions]

    async def load_tasks(self, session_id: str) -> list[dict]:
        self.load_tasks_calls.append(session_id)
        return [{"id": "task_1", "status": "SUCCEEDED", "title": "t", "is_daemon": False}]

    async def load_sse_events(self, session_id: str) -> list[str]:
        self.load_sse_calls.append(session_id)
        await asyncio.sleep(0)  # 让出循环，暴露并发 hydrate 的竞态
        return list(self._sessions[session_id])

    async def append_sse_event(self, session_id: str, event_json: str) -> None:
        self.appended.append((session_id, event_json))


@pytest.fixture
def store():
    """三个会话，各带一段持久化历史。装好 _state_store，用后复原全局。"""
    s = _CountingStore({
        "ses_a": [_msg("user", "q1"), _msg("assistant", "a1"), _msg("user", "q2")],
        "ses_b": [_msg("user", "only")],
        "ses_c": [],
    })
    _sessions.clear()
    set_state_store(s)
    yield s
    _sessions.clear()
    set_state_store(None)


# ── 启动路径 ──────────────────────────────────────────────────────────────────


async def test_startup_loads_metadata_without_touching_children(store) -> None:
    """启动只读 sessions 投影：一次 children 查询都不该发生。"""
    await load_sessions_from_db(store)

    assert set(_sessions) == {"ses_a", "ses_b", "ses_c"}
    assert _sessions["ses_a"].status == "SUCCEEDED"
    assert store.load_sse_calls == [], "启动时不得读任何会话的 SSE 历史"
    assert store.load_tasks_calls == [], "启动时不得读任何会话的 tasks"


async def test_metadata_is_serialisable_without_hydration(store) -> None:
    """列表页只吃 to_dict()，不得因此触发 hydrate。"""
    await load_sessions_from_db(store)

    dumped = [e.to_dict() for e in _sessions.values()]

    assert {d["id"] for d in dumped} == {"ses_a", "ses_b", "ses_c"}
    assert store.load_sse_calls == []


# ── 按需 hydrate ──────────────────────────────────────────────────────────────


async def test_ensure_hydrated_loads_children_and_derived_values(store) -> None:
    """hydrate 补齐 sse_events / tasks，以及那两个从历史算出来的派生值。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]
    assert entry.sse_events == []
    assert entry.turn_seq == 1  # __init__ 的默认值，尚未按历史校正

    await entry.ensure_hydrated()

    assert len(entry.sse_events) == 3
    assert entry.tasks.keys() == {"task_1"}
    assert entry.turn_seq == 2, "ses_a 有两条 user 消息，turn_seq 应被校正为 2"
    assert store.load_sse_calls == ["ses_a"]


async def test_ensure_hydrated_is_idempotent(store) -> None:
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]

    await entry.ensure_hydrated()
    await entry.ensure_hydrated()

    assert store.load_sse_calls == ["ses_a"], "重复调用不得重读"
    assert len(entry.sse_events) == 3, "重复调用不得把历史灌两遍"


async def test_concurrent_hydration_loads_once(store) -> None:
    """并发进入只读一次：否则历史会被追加两遍，SSE 下标全线错位。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]

    await asyncio.gather(*(entry.ensure_hydrated() for _ in range(5)))

    assert store.load_sse_calls == ["ses_a"]
    assert len(entry.sse_events) == 3


async def test_new_session_is_born_hydrated(store) -> None:
    """新建会话的 entry 直接就是全的，不该回头去查库。"""
    entry = SessionEntry(session_id="ses_new", template_id="tpl", user_prompt="hi",
                         tenant_id="default", llm_model=None, llm_account=None)

    await entry.ensure_hydrated()

    assert store.load_sse_calls == []


# ── 追加闸门（下标正确性） ────────────────────────────────────────────────────


async def test_append_hydrates_before_inserting(store) -> None:
    """往冷 entry 追加：新帧必须落在历史之后，而不是空 list 的 0 号位。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]

    await entry._append_json(json.dumps({"type": "message", "role": "assistant", "content": "new"}))

    assert len(entry.sse_events) == 4
    assert json.loads(entry.sse_events[3])["content"] == "new"
    assert json.loads(entry.sse_events[0])["content"] == "q1", "历史必须仍在前面"


async def test_append_on_empty_history_still_marks_hydrated(store) -> None:
    """历史为空的会话也要走完 hydrate，避免每次追加都重查库。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_c"]

    await entry._append_json(json.dumps({"type": "message", "role": "user", "content": "x"}))
    await entry._append_json(json.dumps({"type": "message", "role": "user", "content": "y"}))

    assert entry.sse_events == [
        json.dumps({"type": "message", "role": "user", "content": "x"}),
        json.dumps({"type": "message", "role": "user", "content": "y"}),
    ]
    assert store.load_sse_calls == ["ses_c"], "只该在首次追加时装一次"


# ── SSE 流 ────────────────────────────────────────────────────────────────────


async def _collect(agen, limit: int) -> list[str]:
    out: list[str] = []
    async for chunk in agen:
        out.append(chunk)
        if len(out) >= limit:
            break
    await agen.aclose()
    return out


async def test_sse_generator_hydrates_cold_entry(store) -> None:
    """冷 entry 上建流：history 帧必须带上全部持久化历史，不能是空的。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]
    entry.sse_finished = True  # 让生成器推完首屏即收尾

    chunks = await _collect(sse_generator("ses_a"), 4)
    blob = "".join(chunks)

    assert '"type": "history"' in blob or '"type":"history"' in blob
    history = next(json.loads(c.removeprefix("data: ").strip())
                   for c in chunks if '"history"' in c)
    assert len(history["events"]) == 3, "冷启动后首次建流必须补全历史"
    assert entry.tasks.keys() == {"task_1"}, "init 帧要的 tasks 也应已装上"


# ── append 闸门够不到的入口（在追加之前就读 children 派生值） ──────────────────


async def test_list_tasks_hydrates_cold_entry(store) -> None:
    """GET /tasks 直接读 entry.tasks，不经追加路径，得自己补 hydrate。"""
    import netlivecowork.api.sessions as sessions_mod

    await load_sessions_from_db(store)

    tasks = await sessions_mod.list_tasks("ses_a")

    assert [t["id"] for t in tasks] == ["task_1"], "冷 entry 不该返回空任务列表"


async def test_send_message_hydrates_before_touching_turn_seq(store, monkeypatch) -> None:
    """/messages 在追加之前就 turn_seq += 1，闸门来不及，入口处必须先 hydrate。"""
    import netlivecowork.api.sessions as sessions_mod
    from netlivecowork.api.schemas.sessions import SendMessageRequest

    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]
    entry.status = "PAUSED"          # 走 HITL 转发分支，避免拉起真 runtime

    async def _fake_submit(e, content):
        return {"ok": True}

    monkeypatch.setattr(sessions_mod, "_submit_hitl_response", _fake_submit)
    await sessions_mod.send_message(sid_req := "ses_a", SendMessageRequest(content="hi"), runtime=None)

    assert entry._hydrated, "入口未 hydrate：后续 turn_seq 会从 1 起算，与云端已上报的回合号撞车"
    assert entry.turn_seq == 2, f"应按持久化历史校正为 2，实得 {entry.turn_seq}"
    assert sid_req == "ses_a"


async def test_hitl_reply_lands_after_persisted_history(store, monkeypatch) -> None:
    """HITL 应答直接往 entry.sse_events append（绕过 _append_json 闸门），也须先 hydrate。"""
    from datetime import datetime, timezone

    from ctx_weft.core import CtxWeftRuntime
    from ctx_weft.core.events.types import Event, EventType
    from ctx_weft.core.runtime import ProviderRegistry
    from ctx_weft.protocols.capability import AgentCapabilityProvider, CapabilityProviderInfo
    from netlivecowork.api import deps, hitl as hitl_api, hitl_service
    from netlivecowork.api.schemas.hitl import AnswerRequest

    class _StubProvider(AgentCapabilityProvider):
        name = "agent"
        async def get_template(self, *a, **k): return None
        async def list(self, *a, **k): return []
        async def describe(self, *a, **k):
            return CapabilityProviderInfo(name=self.name, capability_count=0,
                                          supports_streaming=False, supports_cancel=False,
                                          description="")

    sid = "ses_a"
    ts = datetime(2026, 6, 13, tzinfo=timezone.utc)
    providers = ProviderRegistry()
    providers.register_capability(_StubProvider())
    runtime = CtxWeftRuntime(providers=providers)
    for seq, (t, p) in enumerate([
        (EventType.SESSION_CREATED, {"template_id": "t"}),
        (EventType.HITL_REQUIRED, {"hitl_id": "h1", "form": "question", "tool_call_id": "tc1"}),
    ], start=1):
        await runtime.event_store.append(Event(id=f"evt_{seq}", run_id="r1", sequence=seq,
                                               session_id=sid, type=t, timestamp=ts, payload=p))
    await runtime.rebuild_hitl(sid)

    async def _noop(*a, **k): return None
    monkeypatch.setattr(runtime, "recover_session", _noop)
    monkeypatch.setattr(hitl_service, "_ensure_workspace_registered", _noop)

    class _RewindStub:
        """开着 rewind，让应答帧带上 turn_seq（前端据此挂回退按钮）。"""
        def __init__(self): self.snapshots: list[int] = []
        async def snapshot_turn(self, sid, turn, ws): self.snapshots.append(turn)

    await load_sessions_from_db(store)
    entry = _sessions[sid]
    entry.status = "PAUSED_HITL"
    entry.workspace = "C:/ws"
    rw = _RewindStub()
    deps.set_runtime(runtime)
    deps.set_hitl_manager(runtime.hitl_manager)
    deps.set_rewind_manager(rw)
    try:
        await hitl_api.answer("h1", AnswerRequest(answer="ok"), hitl=runtime.hitl_manager)
    finally:
        deps.set_runtime(None)
        deps.set_hitl_manager(None)
        deps.set_rewind_manager(None)

    assert json.loads(entry.sse_events[0])["content"] == "q1", "历史必须仍在最前"
    assert json.loads(entry.sse_events[3])["content"] == "ok", "应答帧应接在 3 条历史之后"
    assert entry.turn_seq == 3, f"按历史校正到 2 再 +1，应为 3，实得 {entry.turn_seq}"
    # this_turn 在 _append_json 闸门【之前】就被读走，冷 entry 上会算成 2。
    # 它既写进帧里当回退锚点、又是 snapshot_turn 的档号，错位会让回滚打到上一回合。
    assert json.loads(entry.sse_events[3])["turn_seq"] == 3, "应答帧的回退锚点回合号错位"
    assert rw.snapshots == [3], f"工作区快照档号错位：{rw.snapshots}"


# ── 单遍扫描（折掉重复解析） ──────────────────────────────────────────────────


def _fail(error: str, *, will_retry: bool = False, recoverable: bool = False) -> str:
    return json.dumps({"type": "task_failed", "error": error, "error_type": "BOOM",
                       "will_retry": will_retry, "recoverable": recoverable})


@pytest.fixture
def mixed_store():
    """一段同时喂饱 turn_seq 与 _last_task_failure 的历史，含两条必须跳过的失败气泡。"""
    s = _CountingStore({"ses_m": [
        _msg("user", "q1"),
        _fail("重试中", will_retry=True),      # 非终态，跳过
        _msg("assistant", "a1"),
        _fail("真失败"),                        # 该被记住的那条
        _msg("user", "q2"),
        _fail("崩溃挂起", recoverable=True),    # 非失败，跳过
    ]})
    _sessions.clear()
    set_state_store(s)
    yield s
    _sessions.clear()
    set_state_store(None)


async def test_single_scan_derives_both_values(mixed_store) -> None:
    """一遍扫完两个派生值，语义与原来的正序 + 逆序两遍完全一致。"""
    await load_sessions_from_db(mixed_store)
    entry = _sessions["ses_m"]

    await entry.ensure_hydrated()

    assert entry.turn_seq == 2, "两条 user 消息"
    assert entry._last_task_failure == {"code": "BOOM", "message": "真失败"}, (
        "应取最后一条【终态】失败气泡，跳过 will_retry 与 recoverable"
    )


async def test_history_frame_preserves_every_kept_event(mixed_store) -> None:
    """history 帧改成直接拼原始 JSON 串，内容必须与逐条解析的结果一致。"""
    await load_sessions_from_db(mixed_store)
    entry = _sessions["ses_m"]
    entry.sse_finished = True

    chunks = await _collect(sse_generator("ses_m"), 4)
    frame = next(json.loads(c.removeprefix("data: ").strip())
                 for c in chunks if '"history"' in c)

    from netlivecowork.api.models.session import _HISTORY_TYPES
    kept = [o for o in (json.loads(raw) for raw in mixed_store._sessions["ses_m"])
            if o["type"] in _HISTORY_TYPES]
    assert frame["events"] == kept, "history 事件必须逐条等价于过滤后的原始帧"
    assert len(kept) == 3, "task_failed 不在 _HISTORY_TYPES，应被滤掉"


async def test_history_frame_is_valid_json_with_lean_filter(store) -> None:
    """lean 过滤掉的帧不能留下空洞或多余逗号（手工拼串最容易在这翻车）。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_a"]
    await entry.ensure_hydrated()
    # 夹一条 lean 该剔除的 llm_prompt，确保拼串时被干净地跳过
    entry.sse_events.insert(1, json.dumps({"type": "llm_prompt", "content": "big"}))
    entry.sse_finished = True

    chunks = await _collect(sse_generator("ses_a", lean=True), 4)
    frame = next(json.loads(c.removeprefix("data: ").strip())
                 for c in chunks if '"history"' in c)

    assert [e["type"] for e in frame["events"]] == ["message"] * 3
    assert all(e.get("content") for e in frame["events"])


async def test_empty_history_frame_is_valid(store) -> None:
    """全空历史拼出来的必须是合法 JSON 的空数组。"""
    await load_sessions_from_db(store)
    entry = _sessions["ses_c"]
    entry.sse_finished = True

    chunks = await _collect(sse_generator("ses_c"), 4)
    frame = next(json.loads(c.removeprefix("data: ").strip())
                 for c in chunks if '"history"' in c)

    assert frame["events"] == []
