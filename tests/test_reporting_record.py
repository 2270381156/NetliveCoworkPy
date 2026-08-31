"""统一入口 record()。

两件事最要紧：**它绝不抛**（打点不能影响业务），以及**数据静默消失时必须留下日志**
（路由没配、出口名拼错，在本地看起来都与"发走了"一模一样）。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.reporting import record as rec
from netlivecowork.reporting import sinks, spool
from netlivecowork.reporting.labels import Labels
from netlivecowork.reporting.routing import Route
from netlivecowork.reporting.sinks.base import Sink
from netlivecowork.reporting.sinks.relay import RelaySink


class _Spy(Sink):
    def __init__(self, name: str, ok: bool = True, boom: bool = False) -> None:
        self.name, self._ok, self._boom = name, ok, boom
        self.got: list = []

    def enqueue(self, delivery) -> bool:
        if self._boom:
            raise RuntimeError("sink exploded")
        self.got.append(delivery)
        return self._ok


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    sinks.reset()
    rec.install_routes(())
    yield tmp_path
    sinks.reset()
    rec.install_routes(())
    cfgmod._settings = None


# ── 绝不抛 ────────────────────────────────────────────────────────────────────

def test_never_raises_when_a_sink_explodes(caplog):
    """**这条最要紧。** 出口炸了业务照常跑。"""
    sinks.register(_Spy("boom", boom=True))
    rec.install_routes((Route(kind="k", sink="boom"),))
    with caplog.at_level("ERROR"):
        assert rec.record("k", {"a": 1}) == 0
    assert "入队失败" in caplog.text


def test_never_raises_on_a_broken_payload(caplog):
    """连载荷本身有问题也不能把调用方带下去。

    （用 dict 子类改 __iter__ 试过，炸不了：``dict(子类)`` 走 C 层快路径不调它。
    要真炸得让 ``keys()`` 抛——那是 ``dict(非 dict)`` 实际会走的路。）
    """
    sinks.register(_Spy("s"))
    rec.install_routes((Route(kind="k", sink="s"),))

    class Boom:
        def keys(self):
            raise RuntimeError("bad payload")

        def __getitem__(self, k):  # pragma: no cover - 到不了
            return None

    with caplog.at_level("ERROR"):
        assert rec.record("k", Boom()) == 0
    assert "record" in caplog.text


# ── 静默消失的两条路，都必须留日志 ────────────────────────────────────────────

def test_unknown_sink_name_is_logged_not_swallowed(caplog):
    """路由里把出口名拼错了 —— 这条数据就此消失，本地看起来却像发走了。"""
    rec.install_routes((Route(kind="k", sink="typo"),))
    with caplog.at_level("WARNING"):
        assert rec.record("k", {}) == 0
    assert "不存在的出口" in caplog.text


def test_no_route_is_logged(caplog):
    with caplog.at_level("WARNING"):
        assert rec.record("k", {}) == 0
    assert "没有路由匹配" in caplog.text


# ── 扇出与计数 ────────────────────────────────────────────────────────────────

def test_counts_only_the_ones_that_actually_got_queued():
    a, b = _Spy("a"), _Spy("b", ok=False)
    sinks.register(a), sinks.register(b)
    rec.install_routes((Route(kind="k", sink="a"), Route(kind="k", sink="b")))
    assert rec.record("k", {"x": 1}) == 1
    assert len(a.got) == 1 and len(b.got) == 1, "两个都试过，只有一个成了"


def test_fans_out_to_every_matching_route():
    a, b = _Spy("a"), _Spy("b")
    sinks.register(a), sinks.register(b)
    rec.install_routes((Route(kind="k", sink="a"), Route(kind="k", sink="b")))
    assert rec.record("k", {"x": 1}) == 2


# ── 归属 ──────────────────────────────────────────────────────────────────────

def test_ownership_defaults_to_unknown_today():
    """cowork 那块还没建，所以恒为空——**但签名里已经有这个参数**，
    等接上时改一个文件就够，调用点一个都不用动。
    """
    s = _Spy("s")
    sinks.register(s)
    rec.install_routes((Route(kind="k", sink="s"),))
    rec.record("k", {}, session_id="ses_1")
    assert s.got[0].labels == Labels()


def test_explicit_labels_win():
    s = _Spy("s")
    sinks.register(s)
    rec.install_routes((Route(kind="k", sink="s", cowork="mbb"),))
    assert rec.record("k", {}, labels=Labels(cowork="mbb")) == 1
    assert s.got[0].labels.cowork == "mbb"


# ── 端到端：走真实的 relay 出口 ───────────────────────────────────────────────

def test_end_to_end_through_the_relay_sink(clean):
    """入口 → 路由 → 出口 → 落到主进程要读的那个文件。"""
    sinks.register(RelaySink("relay:token-usage", "token-usage-spool.jsonl"))
    rec.install_routes((Route(kind="token_usage", sink="relay:token-usage"),))

    assert rec.record("token_usage", {"input_tokens": 5, "llm_model": "m"}) == 1

    rows = spool.claim("token-usage-spool.jsonl")["events"]
    assert len(rows) == 1
    assert rows[0]["event_type"] == "token_usage"
    assert rows[0]["input_tokens"] == 5


def test_relay_does_not_leak_internal_ids_into_the_payload(clean):
    """delivery_id / record_id 是我们内部用的。

    主进程按字段名把内容转给云端，多出来的字段会一路传到对端——而对端字段是有约定的。
    """
    sinks.register(RelaySink("relay:x", "x.jsonl"))
    rec.install_routes((Route(kind="k", sink="relay:x"),))
    rec.record("k", {"a": 1})

    obj = spool.claim("x.jsonl")["events"][0]
    assert set(obj) == {"event_type", "ts", "a"}


def test_projection_applies_end_to_end(clean):
    """脱敏要真的落到文件里，不只是在内存里对。"""
    sinks.register(RelaySink("relay:x", "x.jsonl"))
    rec.install_routes((Route(kind="k", sink="relay:x", fields=("keep",)),))
    rec.record("k", {"keep": 1, "secret": "no"})

    obj = spool.claim("x.jsonl")["events"][0]
    assert "secret" not in json.dumps(obj, ensure_ascii=False)


def test_two_platforms_two_files(clean):
    """同一条数据发给两个平台 = 两个文件各一份，各自的投影。"""
    sinks.register(RelaySink("relay:a", "a.jsonl"))
    sinks.register(RelaySink("relay:b", "b.jsonl"))
    rec.install_routes((
        Route(kind="k", sink="relay:a"),
        Route(kind="k", sink="relay:b", fields=("shared",)),
    ))
    assert rec.record("k", {"shared": 1, "only_a": 2}) == 2

    a = spool.claim("a.jsonl")["events"][0]
    b = spool.claim("b.jsonl")["events"][0]
    assert a["only_a"] == 2
    assert "only_a" not in b
