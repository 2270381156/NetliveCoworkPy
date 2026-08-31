"""low_integrity.activation 的"标一次"标记逻辑（跨平台可测部分）。

真正的 icacls 标 Low 只在 Windows 跑；这里验标记读写 + 非 Windows 时 label_global_writable_dirs
是干净 no-op、不写标记（半自动/Mac 用户零开销）。
"""

from __future__ import annotations

from pathlib import Path

from netlivecowork.low_integrity import windows
from netlivecowork.low_integrity.activation import (
    _mark_workspace_labeled,
    _read_labeled_marker,
    _write_labeled_marker,
    label_global_writable_dirs,
)


def test_marker_roundtrip(tmp_path: Path) -> None:
    m = tmp_path / "low_integrity" / ".low_labeled.json"
    assert _read_labeled_marker(m) == set()          # 不存在 → 空
    _write_labeled_marker(m, {"/venv", "/tmp/low"})
    assert _read_labeled_marker(m) == {"/venv", "/tmp/low"}


def test_marker_corrupt_is_empty(tmp_path: Path) -> None:
    m = tmp_path / "m.json"
    m.write_text("{ not json", encoding="utf-8")
    assert _read_labeled_marker(m) == set()          # 坏文件 → 当未标，不崩


def test_non_windows_is_noop_no_marker(tmp_path: Path) -> None:
    # 非 Windows（Mac/Linux dev）：windows.available()=False → 直接 return，不建目录/不写标记。
    label_global_writable_dirs(tmp_path)
    assert not (tmp_path / "low_integrity" / ".low_labeled.json").exists()


def test_mark_workspace_labeled_persists(tmp_path: Path) -> None:
    # 提权标过的工作区记进标记 → 下次 activate 据此跳过 icacls、不再弹 UAC。
    m = tmp_path / "low_integrity" / ".low_labeled.json"
    _mark_workspace_labeled(m, "D:\\20_code\\temp")
    assert "D:\\20_code\\temp" in _read_labeled_marker(m)
    _mark_workspace_labeled(m, "D:\\other")           # 追加不覆盖
    assert _read_labeled_marker(m) == {"D:\\20_code\\temp", "D:\\other"}


def test_is_icacls_access_denied_detects_zh_en() -> None:
    # 「拒绝访问」(中) / Access is denied (英) → 判为权限问题（触发提权）；其它错误 → 不提权。
    assert windows.is_icacls_access_denied("处理 1 个文件时失败 D:\\x: 拒绝访问") is True
    assert windows.is_icacls_access_denied("D:\\x: Access is denied.") is True
    assert windows.is_icacls_access_denied("The system cannot find the path specified") is False
