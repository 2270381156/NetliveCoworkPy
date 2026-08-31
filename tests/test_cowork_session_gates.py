"""会话侧的三道闸 —— 权限是执行边界，不只是展示。

    建会话     没装的 cowork → 明确的"不可用"，不是 500
    继续会话   被收回的 cowork → 403，不是 404 也不是 500
    读会话     **一律照常** —— 只读会话必须真的读得了

第三条最容易被做错：只读实现成"打开就报错"等于变相删除，用户会认为记录丢了。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.api import cowork_bridge
from netlivecowork.cowork import runtime as cowork_runtime
from netlivecowork.cowork.manifest import MASTER_ID


@pytest.fixture(autouse=True)
def clean():
    cowork_runtime.reset()
    yield
    cowork_runtime.reset()


def _entry(template_id):
    from netlivecowork.api.models.session import SessionEntry
    return SessionEntry(session_id="s1", template_id=template_id, user_prompt="",
                        tenant_id="default", llm_model="m", llm_account="a")


def install(root, cid):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cowork.json").write_text(json.dumps({"id": cid, "version": "1"}), encoding="utf-8")


# ── 可用性（建会话那道闸）────────────────────────────────────────────────────

def test_an_installed_cowork_is_available(tmp_path):
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_available("agent:ipmaster") is True


def test_an_uninstalled_cowork_is_not_available(tmp_path):
    """**绕过界面直接调接口也拿不到没权限的 cowork**（需求 G3）。"""
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_available("agent:mbb") is False


def test_the_master_is_always_available(tmp_path):
    """母版留给历史会话与内部任务，没有谁的权限能收回它。"""
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_available(f"agent:{MASTER_ID}") is True


def test_everything_is_available_without_a_cowork_layer():
    """**衍生品牌可能就是单 agent 形态**（架构设计 D2）。

    没有 cowork 这一层时，这道闸必须完全透明。
    """
    assert cowork_bridge.is_available("agent:anything") is True


def test_everything_is_available_while_nothing_is_installed_yet(tmp_path):
    """一个都没装：可能是还没对账。

    此时拦住新建会让"启动早期"看起来像"没权限"，而那是两回事。
    """
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_available("agent:ipmaster") is True


# ── 只读（继续会话那道闸）────────────────────────────────────────────────────

def test_a_session_of_an_installed_cowork_is_not_readonly(tmp_path):
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_readonly("agent:ipmaster") is False


def test_a_session_of_a_revoked_cowork_is_readonly(tmp_path):
    install(tmp_path, "ipmaster")
    install(tmp_path, "mbb")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_readonly("agent:mbb") is False

    import shutil
    shutil.rmtree(tmp_path / "mbb")
    cowork_runtime.reload()
    assert cowork_bridge.is_readonly("agent:mbb") is True


def test_readonly_is_derived_not_stored(tmp_path):
    """**推导，不写状态**（需求 I4）。

    加字段就得在权限恢复时把它清掉，而"该清没清"是个静默故障——
    用户权限回来了，会话却永远停在只读。
    """
    import shutil

    install(tmp_path, "mbb")
    cowork_runtime.setup(tmp_path, reconciled=True)   # 对账跑过了
    shutil.rmtree(tmp_path / "mbb")
    cowork_runtime.reload()
    assert cowork_bridge.is_readonly("agent:mbb") is True

    install(tmp_path, "mbb")
    cowork_runtime.reload()
    assert cowork_bridge.is_readonly("agent:mbb") is False, (
        "套件装回来，会话自己就该活过来——没有任何标记要清")


def test_a_master_session_is_never_readonly(tmp_path):
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_readonly(f"agent:{MASTER_ID}") is False


def test_nothing_is_readonly_while_the_lineup_is_unknown(tmp_path):
    """**只在阵容确知时才判只读**（需求 I9）。

    一个都没装可能只是还没对账；此时判只读会把一次网络抖动
    显示成"你的权限被收回了"，而后端其实好好的。
    """
    cowork_runtime.setup(tmp_path)
    assert cowork_bridge.is_readonly("agent:mbb") is False


def test_nothing_is_readonly_without_a_cowork_layer():
    assert cowork_bridge.is_readonly("agent:anything") is False


def test_the_two_gates_are_not_simple_opposites(tmp_path):
    """`is_available` 与 `is_readonly` 是一件事的两面，**但不能简单取反**。

    母版与"没有 cowork 这一层"时两者都返回"可以"——
    取反的话母版会话会全部变成只读，历史记录集体不能继续。
    """
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    master = f"agent:{MASTER_ID}"
    assert cowork_bridge.is_available(master) is True
    assert cowork_bridge.is_readonly(master) is False


# ── 绝不抛 ────────────────────────────────────────────────────────────────────

def test_the_gates_never_raise(monkeypatch):
    """**cowork 这一层出问题时，最坏的结果应当是"没做隔离"，而不是"接口挂了"。**"""
    monkeypatch.setattr(cowork_bridge, "_scope",
                        lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert cowork_bridge.is_available("agent:x") is True
    assert cowork_bridge.is_readonly("agent:x") is False
    cowork_bridge.bind_session("ses", "agent:x")


def test_odd_template_ids_do_not_blow_up(tmp_path):
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path)
    for bad in (None, "", "   ", "agent:", "::::"):
        cowork_bridge.is_available(bad)
        cowork_bridge.is_readonly(bad)


# ── 会话响应里的那个字段 ──────────────────────────────────────────────────────

def test_the_session_payload_carries_readonly(tmp_path):
    """**由后端给出而不是前端自己算**（架构设计 Q4）。

    同一条规则两侧各写一遍必然在某个分支上分岔，
    而分岔的现象是"界面让你输入，一发就 403"。
    """
    install(tmp_path, "ipmaster")
    cowork_runtime.setup(tmp_path, reconciled=True)

    entry = _entry("agent:ipmaster")
    assert entry.to_dict()["readonly"] is False

    import shutil
    shutil.rmtree(tmp_path / "ipmaster")
    cowork_runtime.reload()
    assert entry.to_dict()["readonly"] is True


def test_reading_a_revoked_session_still_works(tmp_path):
    """**只读会话必须真的读得了**（需求 I5）。

    如果只读实现成"打开就报错"，等于变相删除——用户会认为记录丢了。
    """
    cowork_runtime.setup(tmp_path)
    install(tmp_path, "gone")
    cowork_runtime.reload()
    import shutil
    shutil.rmtree(tmp_path / "gone")
    cowork_runtime.reload()

    entry = _entry("agent:gone")
    payload = entry.to_dict()                # 不抛
    assert payload["id"] == "s1"
    assert payload["template_id"] == "agent:gone", "记录还在，字段一个不少"
