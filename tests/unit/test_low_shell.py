"""low_shell.make_shell_invoker 委托分支测试（跨平台可测：Mac 上 windows.available()=False）。

低完整性真路径（Low 令牌）只在 Windows 跑，Mac 无从执行；这里只验证"该委托内核时确实委托、
不误入 Low 路径"——这是非 strict-auto 会话零行为差异的保证。
"""

from __future__ import annotations

from pathlib import Path

from netlivecowork.low_integrity import windows
from netlivecowork.low_integrity.env import LowIntegrityLayout
from netlivecowork.low_integrity.low_shell import make_shell_invoker


class _Ctx:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.extra: dict = {}


def _sentinel_kernel_invoker(calls: list):
    def invoker(arguments, ctx):
        calls.append((arguments, ctx))
        return "KERNEL"  # 占位：只验证是否被调用
    return invoker


def test_no_layout_delegates_to_kernel() -> None:
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    out = inv({"command": "echo hi"}, _Ctx("s1"))
    assert out == "KERNEL"
    assert len(calls) == 1


def test_layout_present_but_non_windows_still_delegates() -> None:
    # Mac 上 windows.available() 为 False：即便登记了 layout，也必须回落内核（不能进 Low 路径）。
    assert windows.available() is False
    calls: list = []
    layout = LowIntegrityLayout(workspace=Path("/ws"), shared_env=Path("/venv"), temp=Path("/tmp/low"))
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: layout)
    out = inv({"command": "echo hi"}, _Ctx("s1"))
    assert out == "KERNEL"
    assert len(calls) == 1


def test_none_ctx_delegates() -> None:
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    out = inv({"command": "echo hi"}, None)
    assert out == "KERNEL"
    assert len(calls) == 1


# ── 致命命令拦截（被 powershell -Command / python -c 包裹也要拦，全模式）──────────────

async def test_wrapped_restart_computer_blocked() -> None:
    """内核黑名单逐段取命令词、看不到 powershell 参数里的 Restart-Computer；这里整串扫必须拦下、不下放内核。"""
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    cmd = 'powershell -NoProfile -Command "Start-Sleep -Seconds 2; Restart-Computer -Confirm:$false"'
    out = inv({"command": cmd}, _Ctx("s1"))
    assert out != "KERNEL"            # 没委托内核执行
    assert calls == []                # 内核 invoker 根本没被调
    events = [e async for e in out]
    assert len(events) == 1 and events[0].kind == "error"
    assert events[0].payload["code"] == "FATAL_BLOCKED"


async def test_wrapped_python_restart_blocked() -> None:
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    cmd = "python -c \"import subprocess; subprocess.run(['powershell.exe','-Command','Restart-Computer -Force'])\""
    out = inv({"command": cmd}, _Ctx("s1"))
    assert calls == []
    events = [e async for e in out]
    assert events[0].payload["code"] == "FATAL_BLOCKED"


def test_benign_command_still_delegates() -> None:
    # 加了致命拦截后，普通命令（哪怕含 shutdown 之外的词）仍照常下放内核，零行为差异。
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    assert inv({"command": "python app.py && dir"}, _Ctx("s1")) == "KERNEL"
    assert len(calls) == 1


import pytest  # noqa: E402


@pytest.mark.parametrize("cmd", [
    'powershell -Command "Format-Volume -DriveLetter D"',   # PS 存储销毁
    "diskpart /s clean.txt",                                # 磁盘分区
    "bcdedit /delete {current}",                            # 删引导
    "format D: /fs:ntfs /y",                                # format 带盘符
    'python -c "import ctypes; ctypes.windll.user32.ExitWindowsEx(2,0)"',  # Win32 API
    "(Get-WmiObject Win32_OperatingSystem).Win32Shutdown(2)",             # WMI
])
def test_more_fatal_forms_blocked(cmd) -> None:
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    out = inv({"command": cmd}, _Ctx("s1"))
    assert out != "KERNEL" and calls == []                  # 一律不下放内核


@pytest.mark.parametrize("cmd", [
    'python -c "print(\'{}\'.format(1))"',    # .format() 不能误伤
    "Get-Process | Format-Table",             # Format-Table 不能误伤
    "git add . && git commit -m x",           # add 不能误伤
])
def test_fatal_no_false_positive(cmd) -> None:
    calls: list = []
    inv = make_shell_invoker(_sentinel_kernel_invoker(calls), lambda sid: None)
    assert inv({"command": cmd}, _Ctx("s1")) == "KERNEL"    # 照常下放内核


def test_office_failures_get_one_hint_each() -> None:
    # 三种 Office 失败给三条不同的提示，别糊成一段：
    #  ① 代理没生效——DCOM 用调用方的完整性级别启动进程外服务器，Excel 跟着降级、写不了自己的
    #    临时文件，报错却伪装成「内存或磁盘空间不足」，文本里没有任何权限字样；
    #  ② 本机没装——broker 已按 HRESULT 分了码，认码即可；
    #  ③ Office 写到了工作区外——闸门拦的，和上面两件事无关。
    from netlivecowork.low_integrity.low_shell import (
        _NO_BROKER_HINT,
        _NOT_INSTALLED_HINT,
        _OFFICE_WRITE_HINT,
        failure_hint,
    )

    excel = ("com_error (-2147352567, '发生意外。', (0, 'Microsoft Excel', "
             "'内存或磁盘空间不足，Microsoft Excel 无法再次打开或保存任何文档。'")
    assert failure_hint(excel) is _NO_BROKER_HINT
    assert failure_hint("com_error (-2146959355, '服务器执行失败'") is _NO_BROKER_HINT
    assert failure_hint("[OFFICE_NOT_INSTALLED] 本机没有安装 Microsoft Excel") is _NOT_INSTALLED_HINT
    assert failure_hint("[WRITE_OUTSIDE_WORKSPACE] 这次写入的目标在工作区外") is _OFFICE_WRITE_HINT
    # Office 自己报的业务错不该被贴上任何边界/安装说明——它的原话已经说清了
    assert failure_hint("[COM_ERROR] Microsoft Excel 报错：抱歉，找不到 x.xlsx。") is None

def test_boundary_markers_cover_missing_temp_dir() -> None:
    # Low 子进程连可写临时目录都找不到时，pip/tempfile 报的是 FileNotFoundError，不含权限字样。
    from netlivecowork.low_integrity.low_shell import _looks_like_boundary_denial

    assert _looks_like_boundary_denial(
        "FileNotFoundError: [Errno 2] No usable temporary directory found in ['C:\Temp']") is True
