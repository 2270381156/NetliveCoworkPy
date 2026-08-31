"""前后端契约 —— `/coworks` 返回的字段名必须与前端 `CoworkDTO` 一一对应。

**这种不一致是静默的**：接口 200、前端不报错，只是那几个字段渲染成 undefined，
表现为"卡片上没有名字和颜色"。而两边不是一起改的，很容易只改一边。

⇒ 直接读前端那个 interface 的源码来比对，不靠人记得同步。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from netlivecowork.api.coworks import CoworkResponse

FRONTEND = (
    Path(__file__).resolve().parents[1]
    / "frontend-desktop" / "src" / "agents" / "registry.ts"
)


def _dto_fields() -> set[str]:
    """从前端源码里抠出 CoworkDTO 的字段名。"""
    src = FRONTEND.read_text(encoding="utf-8")
    m = re.search(r"export interface CoworkDTO\s*\{(.*?)\}", src, re.S)
    assert m, "前端没有 CoworkDTO 了？契约测试要跟着改"
    return set(re.findall(r"^\s*(\w+)\s*[?]?\s*:", m.group(1), re.M))


@pytest.mark.skipif(not FRONTEND.is_file(), reason="没有前端源码（后端独立部署）")
def test_the_response_matches_what_the_frontend_expects():
    """**字段名对不上是静默故障**：接口 200、前端不报错，只是渲染成 undefined。"""
    assert set(CoworkResponse.model_fields) == _dto_fields()


@pytest.mark.skipif(not FRONTEND.is_file(), reason="没有前端源码")
def test_the_frontend_reads_the_installed_list_not_a_build_time_constant():
    """阵容必须**运行期从后端拉**。

    构建期内联那份是打包时固定的全量，装几个都显示全部——
    那样"按权限下发"这件事在界面上完全体现不出来。
    """
    src = FRONTEND.read_text(encoding="utf-8")
    assert "hydrateAgents" in src, "前端要有一个运行期填充阵容的入口"


@pytest.mark.skipif(not FRONTEND.is_file(), reason="没有前端源码")
def test_the_frontend_exposes_a_getter_not_a_constant():
    """⚠ **阵容是异步到达的，任何模块顶层的捕获都会永远拿到空**，且不报错，
    只表现为"界面一个 cowork 都没有"。

    ⇒ 对外必须是取值函数，让编译器把每个调用点逼出来（需求 I1）。
    """
    src = FRONTEND.read_text(encoding="utf-8")
    assert "export function getAgents" in src
    assert not re.search(r"^export const AGENTS\b", src, re.M), (
        "不许导出常量阵容——调用方会在模块顶层捕获它，那一份永远停在初始的空数组上"
    )
