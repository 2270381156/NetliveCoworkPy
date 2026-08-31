"""两个订阅者切到 record() 之后，**产出必须与切换前一字不差**。

切换的风险不是"报错"，是**静默不发**：数据本来落进一个文件、主进程来取走再发；
切过去之后要是路由没匹配上，本地什么都不会发生，而"没上报"与"上报了"在本地看起来
一模一样，要等运营那边发现数据缺了才知道。

基准原本是**旧实现 `observability.events.emit` 的真实产物**——切换时直接拿它逐字段比对过
（见提交 4aa3935）。旧实现随后删除，所以这里改成钉住**当时比对出来的那个形状**。

⚠ 这几个字面量不是"我觉得应该长这样"，是**当时实测出来的**。改动它们等于改变发给云端的
数据形状，必须先确认对端能接。
"""
from __future__ import annotations

import pytest

from netlivecowork.reporting import defaults, record as rec, sinks, spool


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    sinks.reset()
    rec.reset()                      # 回到"没人装过路由"——正是生产的初始状态
    yield tmp_path
    sinks.reset()
    rec.reset()
    cfgmod._settings = None


def _rows(spool_file):
    return spool.claim(spool_file)["events"]


def _same_except_ts(a: dict, b: dict) -> bool:
    a, b = dict(a), dict(b)
    a.pop("ts", None), b.pop("ts", None)
    return a == b


# ── 不装任何东西也要照常工作 ──────────────────────────────────────────────────

def test_works_with_nothing_installed(clean):
    """**这条是本次切换的安全底线。**

    没有任何装配步骤、没人调 install_routes、没人注册出口——照样要发得出去。
    否则任何没走到装配那步的路径（测试、单跑脚本、将来新加的入口）都会静默失联。
    """
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s1", turn_seq=2, prompt_tokens=3,
                       completion_tokens=4, llm_account="DS", llm_model="m")

    rows = _rows(defaults.TOKEN_USAGE_SPOOL)
    assert len(rows) == 1, "没装配就发不出去 = 静默失联"


# ── token 用量：与旧实现逐字段一致 ────────────────────────────────────────────

def test_token_usage_row_matches_the_old_emit(clean):
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s1", turn_seq=7, prompt_tokens=11,
                       completion_tokens=13, llm_account="DS", llm_model="deepseek-v4")

    # 旧实现在同样输入下写出的形状（实测比对结果，见文件头）
    old = {
        "event_type": "token_usage",
        "session_id": "desktop:s1:7",
        "input_tokens": 11,
        "output_tokens": 13,
        "llm_account": "DS",
        "llm_model": "deepseek-v4",
    }
    (new,) = _rows(defaults.TOKEN_USAGE_SPOOL)
    assert _same_except_ts(new, old)


def test_token_usage_goes_to_the_file_the_main_process_reads(clean):
    """文件名不能变——两边不是一起发布的，改了这边旧主进程就再也读不到。"""
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                       completion_tokens=0, llm_account=None, llm_model=None)
    assert defaults.TOKEN_USAGE_SPOOL == "token-usage-spool.jsonl"
    assert len(_rows(defaults.TOKEN_USAGE_SPOOL)) == 1


def test_token_usage_none_account_and_model_become_empty_strings(clean):
    """旧实现把 None 归一成空串，下游按空串处理。保持。"""
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                       completion_tokens=0, llm_account=None, llm_model=None)
    row = _rows(defaults.TOKEN_USAGE_SPOOL)[0]
    assert row["llm_account"] == "" and row["llm_model"] == ""


def test_token_usage_skips_when_both_counts_are_non_positive(clean):
    """空轮次不上报——这条早退分支必须保留，否则上报量会凭空多出一批 0。"""
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=0,
                       completion_tokens=0, llm_account="a", llm_model="m")
    assert _rows(defaults.TOKEN_USAGE_SPOOL) == []


def test_token_usage_reports_when_only_one_side_is_positive(clean):
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=0,
                       completion_tokens=5, llm_account="a", llm_model="m")
    assert len(_rows(defaults.TOKEN_USAGE_SPOOL)) == 1


def test_token_usage_never_raises(clean, monkeypatch):
    """它是在会话事件处理路径里被同步调用的——抛出来会打断会话。"""
    from netlivecowork.observability import token_usage_subscriber as mod

    monkeypatch.setattr(mod, "record", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    mod.report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                           completion_tokens=1, llm_account="a", llm_model="m")


def test_token_usage_still_notifies_the_main_process(clean, monkeypatch):
    """通知没了的话主进程要等定时器，用量在界面上会迟到——功能一致包含这条。"""
    called = []
    from netlivecowork.observability import token_usage_subscriber as mod
    monkeypatch.setattr(mod, "_notify", lambda: called.append(1))

    mod.report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                           completion_tokens=1, llm_account="a", llm_model="m")
    assert called == [1]


# ── 失败事件：与旧实现逐字段一致 ──────────────────────────────────────────────

class _Ev:
    def __init__(self, type_, payload=None, session_id="s1", task_id="t1", id="e1"):
        self.type, self.payload = type_, payload or {}
        self.session_id, self.task_id, self.id = session_id, task_id, id


def _failure_types():
    from ctx_weft.core.events.types import EventType
    return EventType.STEP_FAILED.value, EventType.TASK_FAILED.value


@pytest.mark.asyncio
async def test_failure_row_matches_the_old_emit(clean):
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    step, _ = _failure_types()
    await TelemetrySubscriber().on_event(
        _Ev(step, {"error_code": "BOOM", "error_message": "went wrong"})
    )
    old = {
        "event_type": "step_failed",
        "session_id": "s1",
        "task_id": "t1",
        "error_code": "BOOM",
        "error_message": "went wrong",
    }
    (new,) = _rows(defaults.TELEMETRY_SPOOL)
    assert _same_except_ts(new, old)


@pytest.mark.asyncio
async def test_both_failure_types_map_and_land_in_the_telemetry_file(clean):
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    step, task = _failure_types()
    sub = TelemetrySubscriber()
    await sub.on_event(_Ev(step, {"error_code": "A"}))
    await sub.on_event(_Ev(task, {"error_code": "B"}))

    kinds = [r["event_type"] for r in _rows(defaults.TELEMETRY_SPOOL)]
    assert kinds == ["step_failed", "task_failed"]


@pytest.mark.asyncio
async def test_unrelated_events_are_ignored(clean):
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    await TelemetrySubscriber().on_event(_Ev("SOMETHING_ELSE", {}))
    assert _rows(defaults.TELEMETRY_SPOOL) == []


@pytest.mark.asyncio
async def test_content_unsafe_error_message_is_dropped(clean):
    """**这条是隐私要求，不是格式细节。**

    这些 error_code 下的文本是 observer 写的，可能回显 agent 输出——事件只带错误分类，
    不带对话内容。切换时把它漏掉的话，对话内容会顺着上报流出去，且没人会发现。
    """
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    step, _ = _failure_types()
    await TelemetrySubscriber().on_event(
        _Ev(step, {"error_code": "TASK_FAILED_BY_OBSERVER", "error_message": "机密对话内容"})
    )
    row = _rows(defaults.TELEMETRY_SPOOL)[0]
    assert row["error_message"] is None


@pytest.mark.asyncio
async def test_long_error_message_is_truncated(clean):
    """截断保留，否则长堆栈会把上报撑大。"""
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    step, _ = _failure_types()
    await TelemetrySubscriber().on_event(_Ev(step, {"error_code": "X", "error_message": "y" * 999}))
    assert len(_rows(defaults.TELEMETRY_SPOOL)[0]["error_message"]) == 512


@pytest.mark.asyncio
async def test_missing_payload_does_not_blow_up(clean):
    from netlivecowork.observability.telemetry_subscriber import TelemetrySubscriber

    step, _ = _failure_types()
    ev = _Ev(step)
    ev.payload = None
    await TelemetrySubscriber().on_event(ev)
    row = _rows(defaults.TELEMETRY_SPOOL)[0]
    assert row["error_code"] is None and row["error_message"] == ""


@pytest.mark.asyncio
async def test_subscriber_never_raises(clean, monkeypatch):
    """它挂在事件派发上，抛出来会污染派发。"""
    from netlivecowork.observability import telemetry_subscriber as mod

    monkeypatch.setattr(mod, "record", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    step, _ = _failure_types()
    await mod.TelemetrySubscriber().on_event(_Ev(step, {"error_code": "X"}))


# ── 装配期覆盖仍然管用 ────────────────────────────────────────────────────────

def test_explicit_routes_override_the_defaults(clean):
    from netlivecowork.observability.token_usage_subscriber import report_token_usage
    from netlivecowork.reporting.routing import Route

    defaults.install_default_sinks()
    rec.install_routes((Route(kind="token_usage", sink=defaults.RELAY_TELEMETRY),))

    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                       completion_tokens=1, llm_account="a", llm_model="m")

    assert _rows(defaults.TOKEN_USAGE_SPOOL) == [], "被覆盖了就不该再走默认那条"
    assert len(_rows(defaults.TELEMETRY_SPOOL)) == 1


def test_an_explicitly_empty_table_really_means_nothing(clean):
    """"我确实不要任何路由"必须表达得出来，不能被默认值顶回去。"""
    from netlivecowork.observability.token_usage_subscriber import report_token_usage

    rec.install_routes(())
    report_token_usage(session_id="s", turn_seq=1, prompt_tokens=1,
                       completion_tokens=1, llm_account="a", llm_model="m")
    assert _rows(defaults.TOKEN_USAGE_SPOOL) == []
