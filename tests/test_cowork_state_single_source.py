""""套件变了要刷新什么"只能有一份清单。

## 这条测试保护的是什么

套件的派生状态有四样：阵容/策略快照、套件下发的 LLM 账号、模板索引、套件自带的 MCP。
它们原先各刷各的 —— 启动时在装配链上按顺序建，运行期由 `/coworks/recheck` 再列一遍。
**两份清单必须一致，而它们各写各的**，于是每往启动流程里加一样，recheck 就漏一样：

    模板索引没重扫  → 界面上有这个智能体，新建会话 500（TemplateNotFoundError）
    套件 MCP 没注册 → 套件里 use + define 都写着，agent 说自己没有这个工具
    LLM 账号没重建 → 套件收回了，账号还挂着，且带着可用的凭据

三个都真实发生过，都是一个一个补回去的。**这类漏没有任何报错**——功能静静地少一块，
现象离病灶十万八千里。所以这里钉的不是"现在对不对"，而是"以后加东西时会不会又分叉"。
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from netlivecowork.bootstrap import host_runtime


SRC = Path(host_runtime.__file__).parent.parent
COWORKS_API = SRC / "api" / "coworks.py"
LIFECYCLE = SRC / "bootstrap" / "lifecycle.py"

#: 属于"套件派生状态"的刷新动作。谁想单独调它们，都得先问问该不该进 apply_cowork_state。
REFRESH_STEPS = (
    "rebuild_cowork_llm_accounts",
    "_register_suite_mcp_servers",
)


def _calls_in(path: Path) -> set[str]:
    """这个文件里出现的函数调用名（含属性调用的末段）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name):
                out.add(f.id)
            elif isinstance(f, ast.Attribute):
                out.add(f.attr)
    return out


def test_the_single_source_exists_and_is_async():
    assert inspect.iscoroutinefunction(host_runtime.apply_cowork_state)


def test_the_single_source_covers_every_step():
    """四样都要在它里面。少一样，就是又一个「装上了但用不了」。"""
    src = inspect.getsource(host_runtime.apply_cowork_state)
    for step in REFRESH_STEPS:
        assert step in src, f"apply_cowork_state 漏了 {step}"
    assert "reload" in src, "apply_cowork_state 漏了阵容/策略重读"
    assert "sync" in src, "apply_cowork_state 漏了模板重扫"


@pytest.mark.parametrize("path", [COWORKS_API, LIFECYCLE], ids=["recheck", "startup"])
def test_no_one_else_lists_the_steps(path: Path):
    """**两条路都不许自己列。**

    它们只能调 apply_cowork_state。谁在这两个文件里直接调某一步，
    就意味着清单又分叉了——而分叉的代价是下一次加东西时另一条路默默漏掉。
    """
    calls = _calls_in(path)
    leaked = sorted(calls & set(REFRESH_STEPS))
    assert not leaked, (
        f"{path.name} 直接调了 {leaked}；这些属于套件派生状态，"
        f"只能通过 apply_cowork_state 刷新，否则两条路迟早不一致"
    )
    assert "apply_cowork_state" in calls, f"{path.name} 没有调 apply_cowork_state"


def test_each_step_is_isolated_from_the_others():
    """一步失败不该带倒其余几步。

    对账本身已经成功了，派生状态刷新失败只该降级——比如模板重扫挂了，
    LLM 账号照样该重建。整段包一个 try 的话，第一步一抛后面全不做，
    而现象是"有的东西更新了、有的没有"，比整体失败更难查。
    """
    src = inspect.getsource(host_runtime.apply_cowork_state)
    assert src.count("try:") >= 4, "每一步都该各自 try，不能整段包一个"


@pytest.mark.asyncio
async def test_a_failing_step_does_not_stop_the_others(monkeypatch):
    """实跑一遍：让 LLM 那步抛，模板与 MCP 两步仍然要执行。"""
    ran: list[str] = []

    def boom():
        ran.append("llm")
        raise RuntimeError("故意的")

    monkeypatch.setattr(host_runtime, "rebuild_cowork_llm_accounts", boom)
    monkeypatch.setattr(host_runtime, "_register_suite_mcp_servers",
                        lambda: ran.append("mcp"))
    await host_runtime.apply_cowork_state()

    assert "llm" in ran, "没走到 LLM 那步"
    assert "mcp" in ran, "LLM 抛异常之后，MCP 那步被跳过了"
