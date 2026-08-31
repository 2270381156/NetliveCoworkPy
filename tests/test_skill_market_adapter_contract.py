"""技能市场 adapter 契约。

这是重构第 1 步：契约先立起来，还没有任何一家实现它（cowork / mythos 在第 2 步搬进来）。
所以这里用一个最小假实现把契约本身跑一遍——证明它**能被实现**，而且默认行为是对的。

契约要解决的问题：现状里"这是不是 mythos"的判断散在 6 处（market 层 3 处、持久化层 1 处、
旧记录 1 处、装配层 1 处）。加第三家市场要改 6 个地方，漏一处不报错，只是那家行为不对。
"""

from __future__ import annotations

import pytest

from netlivecowork.providers.capability.skills.adapters import (
    MarketContext,
    MarketItem,
    SkillMarketAdapter,
)
from netlivecowork.providers.capability.skills.adapters.base import (
    VISIBILITY_EVERYONE,
    VISIBILITY_PER_USER,
)
from netlivecowork.providers.capability.skills.errors import SkillError


class _Minimal(SkillMarketAdapter):
    """只实现两个必须项的一家。用来验默认行为。"""

    name = "minimal"

    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        return [MarketItem(id="1", name="示例")]

    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        return b"PK\x03\x04"


class _FullFeatured(SkillMarketAdapter):
    """把可选项也覆盖的一家——对应将来的 mythos。"""

    name = "full"

    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        # 按 ctx 里的用户名过滤：契约允许各家自己决定怎么用上下文
        return [MarketItem(id="1", name=f"给 {ctx.username} 的")] if ctx.username else []

    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        return b"PK\x03\x04"

    def import_to_remote(self, data: bytes, filename: str, ctx: MarketContext) -> dict:
        return {"ok": True}

    visibility = VISIBILITY_PER_USER


# ── 契约本身 ──────────────────────────────────────────────────────────────────


def test_two_methods_are_mandatory():
    """少实现一个就该在实例化时炸，而不是调用时才发现。"""

    class _Broken(SkillMarketAdapter):
        name = "broken"

        def list_catalog(self, ctx):  # 缺 download_zip
            return []

    with pytest.raises(TypeError):
        _Broken()


def test_upload_defaults_to_unsupported():
    """默认不支持上传——只有 cowork 支持，不该让别家假装实现一个会失败的方法。"""
    with pytest.raises(SkillError) as e:
        _Minimal().import_to_remote(b"x", "a.zip", MarketContext())
    assert e.value.code == "UNSUPPORTED"
    assert "minimal" in str(e.value)          # 报错要说清是哪家不支持


def test_upload_can_be_overridden():
    assert _FullFeatured().import_to_remote(b"x", "a.zip", MarketContext()) == {"ok": True}


def test_visibility_defaults_to_everyone():
    """默认人人可见。这是当前 cowork 的行为，也是"没特别声明就不按人过滤"的安全默认。"""
    assert _Minimal().visibility == VISIBILITY_EVERYONE


def test_visibility_is_declared_by_the_adapter_itself():
    """取代 reference_store 里那句 `if ref.source == "mythos"`。

    加第三家市场时，改的是这家自己的一个返回值，而不是回持久化层加一个 elif。
    """
    assert _FullFeatured().visibility == VISIBILITY_PER_USER


# ── 上下文与条目 ──────────────────────────────────────────────────────────────


def test_context_has_usable_defaults():
    """不需要用户名的那家（cowork）应当能直接 MarketContext() 调用，不必传空串。"""
    ctx = MarketContext()
    assert ctx.username == "" and ctx.auth_header == ""
    assert _Minimal().list_catalog(ctx)[0].id == "1"


def test_context_is_immutable():
    """上下文会被传给多家 adapter。可变的话，一家改了它，后面几家看到的就不是同一份输入。"""
    with pytest.raises(Exception):
        MarketContext().username = "someone"          # type: ignore[misc]


def test_adapters_may_use_the_context_differently():
    """同一个上下文喂给两家，一家用一家不用——调用方不必知道谁在乎什么。"""
    ctx = MarketContext(username="zhang")
    assert _Minimal().list_catalog(ctx)[0].name == "示例"        # 忽略 username
    assert _FullFeatured().list_catalog(ctx)[0].name == "给 zhang 的"


def test_item_carries_only_the_five_normalised_fields():
    """source / is_pulled **不在** MarketItem 里。

    前者由 market 层按 adapter 的名字填，后者要查引用库。adapter 不认识引用库，
    也不该认识自己叫什么——它只管把这一家的数据翻译过来。
    """
    it = MarketItem(id="1", name="x")
    assert not hasattr(it, "source")
    assert not hasattr(it, "is_pulled")
    assert (it.description, it.updater, it.create_time) == (None, None, None)


def test_item_is_immutable():
    """目录条目会在合并、去重、排序之间流转，可变的话很难查是谁改的。"""
    with pytest.raises(Exception):
        MarketItem(id="1", name="x").name = "y"       # type: ignore[misc]


def test_name_is_part_of_the_contract():
    """name 同时是引用记录里的 source 值——改它等于改用户数据的兼容性，所以它是契约的一部分。"""
    assert _Minimal().name == "minimal"
    assert SkillMarketAdapter.name == ""              # 基类不预设，子类必须自己声明
