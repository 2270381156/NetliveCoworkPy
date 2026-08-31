from __future__ import annotations

from pathlib import Path

import pytest

from netlivecowork.auth.mode_store import BashReviewModeStore


def test_default_is_semiauto():
    assert BashReviewModeStore().get("s1") == "semiauto"


def test_set_and_get_is_per_session():
    store = BashReviewModeStore()
    store.set("s1", "manual")
    assert store.get("s1") == "manual"
    # 隔离：设了 s1 不影响 s2；s2 没设过 → 固定回落 semiauto（不继承 s1 的选择）。
    assert store.get("s2") == "semiauto"


def test_invalid_mode_rejected():
    store = BashReviewModeStore()
    with pytest.raises(ValueError):
        store.set("s1", "yolo")


# ── 持久化 + 隔离 ────────────────────────────────────────────────────────────

def test_persists_across_instances(tmp_path: Path):
    p = tmp_path / "modes.json"
    s1 = BashReviewModeStore(p)
    s1.set("sess-A", "strict-auto")
    # 新实例（模拟重启）从盘恢复：sess-A 保持 strict-auto。
    s2 = BashReviewModeStore(p)
    assert s2.get("sess-A") == "strict-auto"


def test_one_session_auto_does_not_leak_to_others(tmp_path: Path):
    # 核心隔离：某会话切 strict-auto，重启后【其它会话不受影响】、仍是 semiauto。
    p = tmp_path / "modes.json"
    s1 = BashReviewModeStore(p)
    s1.set("sess-A", "strict-auto")
    s2 = BashReviewModeStore(p)                 # 重启
    assert s2.get("sess-A") == "strict-auto"    # 自己保留
    assert s2.get("sess-B") == "semiauto"       # 别的会话不被带成 strict-auto
    assert s2.default() == "semiauto"           # 全局默认不被最近选择污染


def test_legacy_default_field_ignored(tmp_path: Path):
    # 旧版残留的全局 "default":"strict-auto" 字段被忽略——未设过的会话仍回落 semiauto。
    p = tmp_path / "modes.json"
    p.write_text('{"default": "strict-auto", "sessions": {"sess-A": "manual"}}', encoding="utf-8")
    s = BashReviewModeStore(p)
    assert s.get("sess-A") == "manual"          # 每会话记录保留
    assert s.get("other") == "semiauto"         # 不吃旧的粘性默认


def test_corrupt_file_does_not_crash(tmp_path: Path):
    p = tmp_path / "modes.json"
    p.write_text("{ not json", encoding="utf-8")
    s = BashReviewModeStore(p)   # 不抛
    assert s.get("x") == "semiauto"


def test_no_path_is_pure_memory(tmp_path: Path):
    s = BashReviewModeStore(None)
    s.set("a", "manual")
    assert s.get("a") == "manual"
    assert not list(tmp_path.iterdir())   # 没写任何文件
