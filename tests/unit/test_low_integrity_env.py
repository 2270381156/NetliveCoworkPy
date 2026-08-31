"""low_integrity.env 单元测试：可写集 + 两组重定向（跨平台纯逻辑）。"""

from __future__ import annotations

from pathlib import Path

from netlivecowork.low_integrity.env import LowIntegrityLayout, redirect_env


def test_writable_dirs() -> None:
    lay = LowIntegrityLayout(workspace=Path("/ws"), shared_env=Path("/venv"), temp=Path("/tmp/low"))
    assert lay.writable_dirs() == [Path("/ws"), Path("/venv"), Path("/tmp/low")]


def test_writable_dirs_no_shared_env() -> None:
    # dev 态无共享 venv（shared_env=None）→ 可写集只含工作区 + temp。
    lay = LowIntegrityLayout(workspace=Path("/ws"), shared_env=None, temp=Path("/tmp/low"))
    assert lay.writable_dirs() == [Path("/ws"), Path("/tmp/low")]


def test_redirect_env_covers_temp_and_home() -> None:
    out = redirect_env({"PATH": "x", "FOO": "bar"}, "/tmp/low")
    # 原有键保留
    assert out["PATH"] == "x" and out["FOO"] == "bar"
    # 两组去处都指向 Low 目录
    for k in ("TEMP", "TMP", "TMPDIR", "PYTHONPYCACHEPREFIX",
              "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"):
        assert out[k] == "/tmp/low", k


def test_redirect_env_does_not_mutate_input() -> None:
    base = {"TEMP": "orig"}
    out = redirect_env(base, "/tmp/low")
    assert base["TEMP"] == "orig"           # 入参不变
    assert out["TEMP"] == "/tmp/low"
