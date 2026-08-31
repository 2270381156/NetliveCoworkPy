"""打点的归属接上 cowork —— 阶段 6。

当初（打点重构第 1 步）把归属参数埋进 `record()` 的签名、所有调用点都传了会话 id，
**就是为了这一刻只改一个文件**。这一组验证那个判断兑现了。

⚠ 打点侧**不认识 cowork**（架构设计 §7 的依赖规则），
所以接法与 skill 归属一样：装配的地方喂进来。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork import runtime as cowork_runtime
from netlivecowork.reporting import defaults, labels, record as rec, sinks
from netlivecowork.reporting.labels import Labels
from netlivecowork.reporting.routing import Route
from netlivecowork.reporting.sinks.base import Sink


class _Spy(Sink):
    name = "spy"

    def __init__(self):
        self.got = []

    def enqueue(self, delivery):
        self.got.append(delivery)
        return True


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    cowork_runtime.reset()
    labels.reset()
    sinks.reset()
    rec.reset()
    yield
    cowork_runtime.reset()
    labels.reset()
    sinks.reset()
    rec.reset()
    cfgmod._settings = None


def install(root, cid):
    d = root / "coworks" / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(json.dumps({"id": cid, "version": "1"}), encoding="utf-8")


def _wire(tmp_path):
    """照装配那样接一次。"""
    from netlivecowork.bootstrap.host_runtime import _reporting_labels_of

    cowork_runtime.setup(tmp_path / "coworks")
    labels.install_resolver(_reporting_labels_of)


# ── 没接上时：与从前一样 ──────────────────────────────────────────────────────

def test_without_a_resolver_ownership_is_unknown():
    """**没接就是"归属未知"，行为与接之前一样。**

    这条保证打点这块可以独立于 cowork 存在（架构设计 §2.1：
    cowork 不做，打点照样能整理）。
    """
    assert labels.labels_for_session("ses-1") == Labels()


def test_a_failing_resolver_never_breaks_reporting():
    """**打点不能影响业务。** 归属这一步失败最多是"这条数据没有归属"。"""
    labels.install_resolver(lambda _: (_ for _ in ()).throw(RuntimeError("boom")))
    assert labels.labels_for_session("ses-1") == Labels()


def test_a_resolver_returning_none_is_tolerated():
    labels.install_resolver(lambda _: None)
    assert labels.labels_for_session("ses-1") == Labels()


# ── 接上之后 ──────────────────────────────────────────────────────────────────

def test_the_cowork_of_a_session_reaches_the_labels(tmp_path):
    """**这就是当初那句"只改一个文件"的兑现。**"""
    install(tmp_path, "ipmaster")
    _wire(tmp_path)
    cowork_runtime.get_scope().bind("ses-1", "ipmaster")

    assert labels.labels_for_session("ses-1").cowork == "ipmaster"


def test_a_session_without_ownership_stays_unknown(tmp_path):
    """历史会话、母版会话、内部任务 —— 归属确实是"不知道"。"""
    install(tmp_path, "ipmaster")
    _wire(tmp_path)
    assert labels.labels_for_session("never-bound").cowork == ""


def test_the_account_comes_from_the_logged_in_user(tmp_path):
    """账号从当前登录用户取：桌面端是单用户进程，运行时没有前端请求可问。"""
    from netlivecowork.providers.capability.skills import current_user

    install(tmp_path, "ipmaster")
    _wire(tmp_path)
    current_user.set_current_username("zhang")
    try:
        assert labels.labels_for_session("x").account == "zhang"
    finally:
        current_user.set_current_username("")


# ── 端到端：归属一路带到出口 ──────────────────────────────────────────────────

def test_ownership_reaches_the_sink(tmp_path):
    """端到端：会话归属 → record() → 路由 → 出口手里那条数据带着它。"""
    install(tmp_path, "mbb")
    _wire(tmp_path)
    cowork_runtime.get_scope().bind("ses-mbb", "mbb")

    spy = _Spy()
    sinks.register(spy)
    rec.install_routes((Route(kind="skill_usage", sink="spy"),))
    rec.record("skill_usage", {"function_name": "docx"}, session_id="ses-mbb")

    assert spy.got[0].labels.cowork == "mbb"


def test_routing_can_now_target_a_specific_cowork(tmp_path):
    """**这是接归属的全部意义**：按 cowork 把数据分给不同的平台。"""
    install(tmp_path, "ipmaster")
    install(tmp_path, "mbb")
    _wire(tmp_path)
    scope = cowork_runtime.get_scope()
    scope.bind("ses-ip", "ipmaster")
    scope.bind("ses-mbb", "mbb")

    ip_sink, mbb_sink = _Spy(), _Spy()
    ip_sink.name, mbb_sink.name = "ip-cloud", "mbb-cloud"
    sinks.register(ip_sink), sinks.register(mbb_sink)
    rec.install_routes((
        Route(kind="skill_usage", cowork="ipmaster", sink="ip-cloud"),
        Route(kind="skill_usage", cowork="mbb", sink="mbb-cloud"),
    ))

    rec.record("skill_usage", {"n": 1}, session_id="ses-ip")
    rec.record("skill_usage", {"n": 2}, session_id="ses-mbb")

    assert [d.payload["n"] for d in ip_sink.got] == [1]
    assert [d.payload["n"] for d in mbb_sink.got] == [2]


def test_unknown_ownership_still_does_not_match_a_named_route(tmp_path):
    """**归属未知 ≠ 属于所有人**（打点第 1 步就定下的规则，这里再钉一次）。

    否则历史会话的数据会流向某个 cowork 专属的平台，而那不可撤销。
    """
    install(tmp_path, "ipmaster")
    _wire(tmp_path)

    spy = _Spy()
    sinks.register(spy)
    rec.install_routes((Route(kind="skill_usage", cowork="ipmaster", sink="spy"),))
    rec.record("skill_usage", {"n": 1}, session_id="no-such-session")

    assert spy.got == []


def test_a_wildcard_route_still_catches_everything(tmp_path):
    """按 cowork 分之外，仍要能配"全都发给某处"。"""
    install(tmp_path, "ipmaster")
    _wire(tmp_path)

    spy = _Spy()
    sinks.register(spy)
    rec.install_routes((Route(kind="skill_usage", sink="spy"),))
    rec.record("skill_usage", {"n": 1}, session_id="anything")

    assert len(spy.got) == 1


# ── 依赖方向 ──────────────────────────────────────────────────────────────────

def test_reporting_does_not_import_cowork():
    """架构设计 §7 的依赖规则在这一块同样成立。

    （`tests/test_cowork_dependency_rule.py` 已经机械检查了 reporting/，
    这里再从行为上确认一次：不接 resolver 时它照常工作。）
    """
    import ast
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src" / "netlivecowork" / "reporting"
    for f in src.rglob("*.py"):
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            mod = ""
            if isinstance(node, ast.ImportFrom) and node.module:
                mod = node.module
            elif isinstance(node, ast.Import):
                mod = node.names[0].name
            assert not mod.startswith("netlivecowork.cowork"), f"{f.name} 不该认识 cowork"
