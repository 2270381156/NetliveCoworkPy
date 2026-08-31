"""exe 标签还原：目录标 Low 会连带把 .exe 标成 Low，导致【任何模式】下由它启动的进程降级。

背景（真机实测）：Windows 新进程的完整性级别 = min(令牌 IL, 主映像文件 IL)。共享 venv 被
`icacls (OI)(CI)L /T` 标过之后，`Scripts\\python.exe` 是 Low 标签文件，于是半自动/人工模式下
由 Medium 后端启动的 python 也是 Low 进程——而那条路径不做 env 重定向，子进程带着真实 %TEMP%
以 Low 运行，pip 报 "No usable temporary directory"、pywin32 建 gen_py 报 WinError 5。

这里测的是跨平台可测的部分：目录扫描选目标、非 Windows 干净 no-op。icacls 本身只在 Windows 跑。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from netlivecowork.low_integrity import windows


def test_find_executable_dirs_collects_dirs_with_exe(tmp_path: Path) -> None:
    (tmp_path / "Scripts").mkdir()
    (tmp_path / "Scripts" / "python.exe").write_bytes(b"MZ")
    (tmp_path / "Scripts" / "activate.bat").write_text("rem")
    (tmp_path / "Lib" / "site-packages" / "pkg").mkdir(parents=True)
    (tmp_path / "Lib" / "site-packages" / "pkg" / "mod.py").write_text("x")
    (tmp_path / "Lib" / "site-packages" / "pkg" / "tool.exe").write_bytes(b"MZ")

    hits = set(windows.find_executable_dirs(str(tmp_path)))
    assert hits == {
        str(tmp_path / "Scripts"),
        str(tmp_path / "Lib" / "site-packages" / "pkg"),
    }


def test_find_executable_dirs_non_recursive_stays_at_root(tmp_path: Path) -> None:
    # venv 的 Scripts 只需平扫一层：site-packages 里几乎没有 exe，递归纯属浪费启动时间。
    (tmp_path / "python.exe").write_bytes(b"MZ")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "other.exe").write_bytes(b"MZ")
    assert windows.find_executable_dirs(str(tmp_path), recursive=False) == [str(tmp_path)]


def test_find_executable_dirs_ignores_non_exe_and_empty(tmp_path: Path) -> None:
    # .dll/.bat/.cmd 都不会导致进程降级（.bat 由 System32 的 cmd.exe 承载），不该被收进来。
    (tmp_path / "a.dll").write_bytes(b"MZ")
    (tmp_path / "b.cmd").write_text("rem")
    (tmp_path / "c.py").write_text("x")
    assert windows.find_executable_dirs(str(tmp_path)) == []


def test_find_executable_dirs_survives_missing_root(tmp_path: Path) -> None:
    # 竞态删除/无权限：跳过即可，绝不抛（调用点都在 best-effort 路径上）。
    assert windows.find_executable_dirs(str(tmp_path / "nope")) == []


def test_find_executable_dirs_respects_dir_limit(tmp_path: Path) -> None:
    for i in range(5):
        d = tmp_path / f"d{i}"
        d.mkdir()
        (d / "x.exe").write_bytes(b"MZ")
    assert len(windows.find_executable_dirs(str(tmp_path), dir_limit=3)) < 5


@pytest.mark.skipif(os.name == "nt", reason="非 Windows 才验 no-op")
def test_restore_is_noop_off_windows(tmp_path: Path) -> None:
    (tmp_path / "x.exe").write_bytes(b"MZ")
    assert windows.restore_executables_medium(str(tmp_path)) == 0
