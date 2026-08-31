"""create_session 默认模板选择：NLC_DEFAULT_TEMPLATE_ID 存在则用，否则回落列表首个。

历史 bug：cfg.default_template_id 只接到了 DirAgentCapabilityProvider 的 facet 合并源，
create_session 的默认选择一直取 store.list_all()[0]，环境变量看似"不生效"。
"""

from __future__ import annotations

from types import SimpleNamespace

import netlivecowork.config as config
from netlivecowork.api.sessions import _resolve_default_template_id


class _Store:
    def __init__(self, rows, by_id=None):
        self._rows = rows
        self._by_id = by_id or {}

    async def get(self, tid):
        return self._by_id.get(tid)

    async def find_by_name(self, name):
        return self._by_id.get(name)

    async def list_all(self):
        return self._rows


def _set_default(monkeypatch, value: str) -> None:
    monkeypatch.setattr(
        config, "get_settings",
        lambda: SimpleNamespace(default_template_id=value),
    )


async def test_configured_default_used_when_exists(monkeypatch):
    _set_default(monkeypatch, "writer")
    store = _Store(
        rows=[{"id": "a"}, {"id": "writer"}],
        by_id={"writer": {"id": "writer"}},
    )
    assert await _resolve_default_template_id(store) == "writer"


async def test_configured_default_missing_falls_back_to_first(monkeypatch):
    _set_default(monkeypatch, "nope")
    store = _Store(rows=[{"id": "a"}, {"id": "b"}])
    assert await _resolve_default_template_id(store) == "a"


async def test_find_by_name_fallback_resolves_to_store_id(monkeypatch):
    # 配置的是模板 name、store 主键是别的 id → 用 find_by_name 命中并返回其真实 id
    _set_default(monkeypatch, "Writer Agent")
    store = _Store(
        rows=[{"id": "a"}],
        by_id={"Writer Agent": {"id": "tpl_writer"}},
    )
    assert await _resolve_default_template_id(store) == "tpl_writer"


async def test_empty_store_keeps_echo_fallback(monkeypatch):
    _set_default(monkeypatch, "default")
    assert await _resolve_default_template_id(_Store(rows=[])) == "echo"
