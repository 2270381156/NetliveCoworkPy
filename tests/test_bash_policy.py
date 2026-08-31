"""Pure classification of bash commands into ALLOW / CONFIRM / DENY."""
from __future__ import annotations

import sys

import pytest

from netlivecowork.auth.bash_policy import Verdict, classify

WS = "C:\\work\\ws"

# 这些用例断言的是 Windows 绝对路径/盘符开关语义（如 C:\work\ws、cd /d）。判定靠 os.path，
# 在非 Windows 上把反斜杠当普通字符 → 结果不同，故仅在 Windows 有意义（CI/真机跑）。
_win_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows 路径语义，仅 Windows 有效")


@pytest.mark.parametrize("cmd", ["ls -la", "dir", "echo hi", "python app.py", "type README.md"])
def test_plain_commands_allow(cmd):
    assert classify(cmd, WS).verdict is Verdict.ALLOW


@pytest.mark.parametrize("cmd", ["curl http://x", "wget http://x", "iwr http://x", "Invoke-WebRequest http://x"])
def test_network_allowed_now(cmd):
    # 网络硬拒已移除：联网命令视同普通命令（无风险词、无越界路径）→ ALLOW。
    assert classify(cmd, WS).verdict is Verdict.ALLOW


@pytest.mark.parametrize("cmd", ["rm -rf build", "del x.txt", "move a b", "ren a b", "sudo ls", "chmod +x f", "chown me f"])
def test_dangerous_confirm(cmd):
    assert classify(cmd, WS).verdict is Verdict.CONFIRM


def test_env_prefix_does_not_hide_rm():
    assert classify("FOO=1 rm x", WS).verdict is Verdict.CONFIRM


def test_chained_network_in_second_segment_now_allowed():
    # 网络硬拒已移除：链式命令里的联网段也不再拦。
    assert classify("echo hi && curl http://x", WS).verdict is Verdict.ALLOW


def test_absolute_path_outside_workspace_confirm():
    assert classify("cat C:\\Windows\\system.ini", WS).verdict is Verdict.CONFIRM


@pytest.mark.parametrize("cmd", [
    'cat "C:\\Windows\\system.ini"',      # 双引号包裹（带空格路径常见写法）
    "cat '/etc/passwd'",                   # 单引号
    'cat "/etc/passwd"',                   # 双引号 + POSIX 绝对
    'mkdir "D:\\server-100.102.211.138"',  # 往工作区外的盘（D:）建目录
])
def test_quoted_absolute_path_outside_confirm(cmd):
    # 回归：shlex(posix=False) 保留引号曾导致越界路径被静默放行。
    assert classify(cmd, WS).verdict is Verdict.CONFIRM


@pytest.mark.parametrize("cmd", [
    "type \\Windows\\System32\\drivers\\etc\\hosts",  # 单前导反斜杠=当前盘根绝对路径
    "cat \\/etc/passwd",                              # POSIX bash 转义 \/ = /
])
def test_single_leading_backslash_outside_confirm(cmd):
    # 回归：_ABS_PATH 曾只认双反斜杠，单个前导反斜杠的绝对路径被漏判。
    assert classify(cmd, WS).verdict is Verdict.CONFIRM


@_win_only
def test_absolute_path_inside_workspace_allows():
    assert classify("cat C:\\work\\ws\\notes.txt", WS).verdict is Verdict.ALLOW


def test_parent_traversal_confirm():
    assert classify("cat ../secret.txt", WS).verdict is Verdict.CONFIRM


def test_unknown_workspace_absolute_path_confirm():
    assert classify("cat C:\\work\\ws\\notes.txt", None).verdict is Verdict.CONFIRM


def test_empty_command_allows():
    assert classify("   ", WS).verdict is Verdict.ALLOW


# --- FIX I1: redirect-glued out-of-workspace paths ---

def test_redirect_glued_abs_path_outside_ws_confirm():
    """echo pwned >C:\\Windows\\x (no space) must CONFIRM, not ALLOW."""
    assert classify("echo pwned >C:\\Windows\\System32\\drivers\\etc\\hosts", WS).verdict is Verdict.CONFIRM


def test_double_redirect_glued_abs_path_outside_ws_confirm():
    """echo pwned >>C:\\Windows\\x (no space, append redirect) must CONFIRM."""
    assert classify("echo pwned >>C:\\Windows\\x", WS).verdict is Verdict.CONFIRM


def test_redirect_glued_relative_path_inside_ws_allow():
    """echo hi >out.txt (relative target, stays in workspace) must ALLOW."""
    assert classify("echo hi >out.txt", WS).verdict is Verdict.ALLOW


# --- FIX I2: PowerShell deletion/move cmdlets ---

def test_remove_item_confirm():
    assert classify("Remove-Item -Recurse -Force build", WS).verdict is Verdict.CONFIRM


def test_ri_alias_confirm():
    assert classify("ri build", WS).verdict is Verdict.CONFIRM


def test_rd_alias_confirm():
    assert classify("rd build", WS).verdict is Verdict.CONFIRM


def test_move_item_confirm():
    assert classify("Move-Item a b", WS).verdict is Verdict.CONFIRM


# --- FIX: Windows command switches (/d /s /q /c) must not be read as POSIX abs paths ---

@_win_only
def test_cd_drive_switch_inside_workspace_allows():
    r"""`cd /d <abs path inside ws>` must ALLOW — the /d switch must not be read as a path.

    Regression: a command whose target dir is INSIDE the workspace still triggered HITL
    because `/d` matched the abs-path regex (/d -> C:\d -> outside)."""
    cmd = r"cd /d C:\work\ws\tmp && node create_pptx.js"
    assert classify(cmd, WS).verdict is Verdict.ALLOW


def test_division_operator_not_treated_as_path():
    # bare '/' (division) inside a `python -c` script must NOT be read as the
    # filesystem root and flagged out-of-workspace. Regression: a contrast-ratio
    # script with `c / 255.0` was wrongly sent to human review.
    cmd = 'python -c "\nx = c / 255.0\ny = (a + 0.055) / 1.055\n"'
    assert classify(cmd, WS).verdict is Verdict.ALLOW


def test_bare_separator_tokens_are_not_paths():
    from netlivecowork.auth.bash_policy import is_outside_workspace
    assert is_outside_workspace("/", WS) is False
    assert is_outside_workspace("//", WS) is False
    assert is_outside_workspace("\\\\", WS) is False
    # a real absolute path is still flagged outside
    assert is_outside_workspace("/etc/passwd", WS) is True


@_win_only
def test_windows_switches_not_treated_as_paths():
    assert classify("dir /s", WS).verdict is Verdict.ALLOW
    assert classify(r"cd /d C:\work\ws\sub", WS).verdict is Verdict.ALLOW
    assert classify("tree /f", WS).verdict is Verdict.ALLOW


def test_real_posix_abs_path_still_confirms():
    """A genuine POSIX absolute path (component >= 2 chars) is NOT a switch and still CONFIRMs."""
    assert classify("cat /etc/passwd", WS).verdict is Verdict.CONFIRM
    assert classify("cd /etc", WS).verdict is Verdict.CONFIRM


def test_switch_does_not_mask_dangerous_or_outside():
    """The switch exemption must not let a dangerous verb or a real outside path slip through."""
    assert classify(r"del /q C:\Windows\x", WS).verdict is Verdict.CONFIRM   # del is dangerous
    assert classify(r"cd /d D:\other", WS).verdict is Verdict.CONFIRM        # real outside abs path


# --- allowed_roots: 共享 venv 在工作区外，但引用其绝对路径应被当「区内」放行（POSIX，Mac 可跑）---

def test_allowed_root_shared_venv_absolute_path_allows():
    from netlivecowork.auth.bash_policy import is_outside_workspace
    ws, venv = "/work/ws", "/app/shared_venv"
    # 不给白名单：共享 venv 的绝对路径判越界 → CONFIRM。
    assert is_outside_workspace("/app/shared_venv/bin/python", ws) is True
    assert classify("/app/shared_venv/bin/python -m pip install requests", ws).verdict is Verdict.CONFIRM
    # 给白名单：同一路径视为区内 → 不再越界、ALLOW。
    assert is_outside_workspace("/app/shared_venv/bin/python", ws, (venv,)) is False
    assert classify(
        "/app/shared_venv/bin/python -m pip install requests", ws, (venv,),
    ).verdict is Verdict.ALLOW
    # 白名单不放水：venv 之外的越界路径仍然 CONFIRM。
    assert classify("cat /etc/passwd", ws, (venv,)).verdict is Verdict.CONFIRM


@_win_only
def test_allowed_root_on_different_drive_than_workspace():
    r"""跨盘符回归：工作区在 D:、共享 venv 在 C:（Win 上极常见）。commonpath 对不同盘符抛
    ValueError；逐根 try 必须让工作区那个跨盘根被跳过、仍轮到 venv 根命中，否则白名单静默失效。"""
    from netlivecowork.auth.bash_policy import is_outside_workspace
    ws, venv = r"D:\work\ws", r"C:\app\shared_venv"
    # venv 里的绝对路径：给白名单 → 视为区内（不因工作区跨盘而误判越界）。
    assert is_outside_workspace(r"C:\app\shared_venv\Scripts\python.exe", ws, (venv,)) is False
    assert classify(
        r"C:\app\shared_venv\Scripts\python.exe -m pip install requests", ws, (venv,),
    ).verdict is Verdict.ALLOW
    # 既不在工作区(D:)也不在 venv(C:) 的第三处路径仍判越界。
    assert is_outside_workspace(r"C:\Windows\system.ini", ws, (venv,)) is True
