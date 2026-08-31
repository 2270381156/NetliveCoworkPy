"""依赖方向：**现有后端不得反过来 import cowork**。

架构设计 §1 把"解耦"变成了三条可验标准，D1 就是这一条。约定靠不住——
它一旦破了，解耦就只剩口号，**而破的那一刻不报错**，只是下一个人照着抄。

⚠ 另一条同样重要的教训（见架构设计 §9ter.1）：运营打点那次我在设计里写了
"队列只留一套"，做完自查才发现实际留了两套。**文档里的数字证明不了代码**，
所以这里数的是 import 语句本身。
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "netlivecowork"

#: 这几层是"现有后端"，它们不该认识 cowork。
FORBIDDEN_ROOTS = ("providers", "persistence", "web", "observability", "reporting")

#: 允许认识 cowork 的地方，每一条都要写明理由。
ALLOWED = {
    "bootstrap",   # 装配的地方：唯一同时认识 cowork 与具体 provider 的位置
    "cowork",      # 它自己
    "api",         # 只允许一个薄路由（见下面单独的用例）
}


def _imports(path: Path) -> list[str]:
    """这个文件 import 了哪些模块（含 from ... import）。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as e:  # pragma: no cover - 有语法错的话别的测试会先炸
        pytest.fail(f"{path} 语法错误：{e}")
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.append(node.module)
    return out


def _files_under(root: str) -> list[Path]:
    d = SRC / root
    return sorted(d.rglob("*.py")) if d.is_dir() else []


@pytest.mark.parametrize("root", FORBIDDEN_ROOTS)
def test_the_existing_backend_does_not_import_cowork(root):
    """**D1。** 破了这条，"去掉 cowork 后端还能跑"就不再成立。

    衍生品牌可能就是单 agent 形态；cowork 的判断一旦散进 provider 内部，
    那种形态就得靠一堆 `if cowork is None` 撑着——而那正是今天那份死配置的下场。
    """
    offenders = [
        (f.relative_to(SRC).as_posix(), m)
        for f in _files_under(root)
        for m in _imports(f)
        if m.startswith("netlivecowork.cowork")
    ]
    assert offenders == [], (
        f"{root}/ 不该认识 cowork：{offenders}\n"
        "要用它的话，让装配的地方把结果喂进来（架构设计 §3.2）"
    )


#: 接口层里允许认识 cowork 的文件，**每一条都要写明它是什么角色**。
#:
#: 这份名单防的不是文件数，而是**权限判断散开** —— 散开之后，
#: "绕过界面直接调接口能不能拿到没权限的东西"就没人能回答了。
#: 所以判断只能有一处（bridge），其余只能是薄路由（转发，不判断）。
API_MAY_KNOW_COWORK = {
    "api/cowork_bridge.py": "判断收口处：登记归属、推导只读、可用性校验都在这里",
    "api/coworks.py": "薄路由：GET /coworks 与 recheck，只转发，不做任何权限判断",
}


def test_only_the_listed_api_files_may_import_cowork():
    """接口层认识 cowork 的地方必须在白名单里，且**每一条都写明角色**。

    加一个新文件进来时，写理由这一步会逼人回答"它到底是判断还是转发"——
    而那正是这条规则要守的东西。
    """
    users = sorted({
        f.relative_to(SRC).as_posix()
        for f in _files_under("api")
        for m in _imports(f)
        if m.startswith("netlivecowork.cowork")
    })
    unexpected = [u for u in users if u not in API_MAY_KNOW_COWORK]
    assert unexpected == [], (
        f"这些接口层文件认识 cowork，但不在白名单里：{unexpected}\n"
        "判断收口在 cowork_bridge；别的地方只能是薄路由，且要在名单里写明角色"
    )


def test_the_judgement_lives_in_exactly_one_place():
    """**判断只有一处。** 薄路由不许自己判权限，只能转发。

    实测过这条规则的价值：写阶段 7 时我在两个文件里各写了一处判断，
    这条测试当场拦下（当时它还是"最多一个文件"的粗判据）。
    """
    route = SRC / "api" / "coworks.py"
    if not route.is_file():
        return
    src = route.read_text(encoding="utf-8")
    for banned in ("installed_ids", "is_readonly", "is_available", "allows_mcp"):
        assert banned not in src, (
            f"薄路由里出现了权限判断 {banned!r} —— 判断应当收在 cowork_bridge"
        )


def test_cowork_does_not_import_the_api_or_persistence_layer():
    """反向也要干净：cowork 只依赖内核协议与自己的东西。

    它一旦 import 接口层，就会把"HTTP 长什么样"带进领域逻辑，
    而那段逻辑（对账、差集）正是因为**不碰网络**才好测。
    """
    offenders = [
        (f.relative_to(SRC).as_posix(), m)
        for f in _files_under("cowork")
        for m in _imports(f)
        if m.startswith("netlivecowork.api") or m.startswith("netlivecowork.persistence")
    ]
    assert offenders == [], f"cowork 不该认识接口层/存储层：{offenders}"


def test_the_pure_logic_really_is_pure():
    """对账逻辑不许碰网络、文件、时间。

    它被单独拆出来的全部理由就是"能把所有分支一个不落地摆出来测"——
    一旦引进 I/O，就只能靠起服务来测，而实际结果是没人测。
    """
    mods = _imports(SRC / "cowork" / "entitlement.py")
    for banned in ("httpx", "requests", "pathlib", "os", "time", "json"):
        assert banned not in mods, f"entitlement.py 不该 import {banned}"
