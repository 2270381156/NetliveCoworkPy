"""strict-auto = 纯完整性准入：一律放行（含网络），文件/系统边界交给 OS 完整性②。

不再有 path 判断 / 危险动词判断 / 网络硬拒——命令级硬拒已全部移除。这里在【授权器层面】
验证 strict-auto 分支「什么都放行」的真实行为。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from netlivecowork.auth.bash_authorizer import SelectiveBashAuthorizer
from netlivecowork.auth.bash_policy import Verdict, classify
from netlivecowork.auth.mode_store import BashReviewModeStore


class _Agent:
    def __init__(self, sid: str) -> None:
        self.session_id = sid
        self.id = "agent-1"


class _Cap:
    id = "fs:shell"
    name = "shell"
    description = ""


def _decide(cmd: str, ws: str, mode: str = "strict-auto") -> bool:
    store = BashReviewModeStore()
    store.set("s", mode)
    az = SelectiveBashAuthorizer(
        hitl_manager=None, mode_store=store, workspace_lookup=lambda _sid: ws,
    )
    d = asyncio.run(
        az.authorize(_Cap(), _Agent("s"), None, None, {"command": cmd})
    )
    return d.allowed


def test_strict_auto_allows_everything(tmp_path: Path) -> None:
    ws = str(tmp_path)
    # 文件操作（含越界、删旧文件）、读工作区外、脚本、系统/权限动词、【网络】——全自动下全放行，
    # 由 OS 完整性在运行时决定越界写成不成（Windows 拦、Mac 不拦）。
    for cmd in [
        "ls -la ..",                 # 读工作区外：以前被误杀，现在放行
        "cat ../secret.txt",         # 读工作区外
        "rm foo.txt",                # 工作区内删
        "rm /etc/passwd",            # 越界删：准入不再判，交给完整性
        r"del C:\Windows\x",         # 越界删
        "chmod 777 x",               # 权限动词：不再准入拒
        "reg add HKLM\\a",           # 系统动词
        "sudo rm x",                 # 提权
        "python run.py",             # 脚本
        "curl http://x",             # 网络：硬拒已移除
        "wget http://y", "ssh host",
    ]:
        assert _decide(cmd, ws) is True, cmd


def test_network_no_longer_denied_at_classify(tmp_path: Path) -> None:
    # 网络硬拒已移除：curl 不再命中任何风险 → ALLOW（不再 DENY）。
    assert classify("curl http://x", str(tmp_path)).verdict is Verdict.ALLOW


def test_auto_mode_unaffected_rm_still_confirms(tmp_path: Path) -> None:
    # 回归：auto 模式下 rm 仍是 CONFIRM（不是 strict-auto 的放行）——证明改动没串到现有模式。
    d = classify("rm foo.txt", str(tmp_path))
    assert d.verdict is Verdict.CONFIRM


def test_mode_store_accepts_strict_auto() -> None:
    s = BashReviewModeStore()
    s.set("sid", "strict-auto")
    assert s.get("sid") == "strict-auto"
