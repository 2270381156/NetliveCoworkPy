"""命名管道：服务端（Medium broker）建管道，客户端（Low agent）连管道。仅 Windows。

**为什么要专门写安全描述符**：管道对象默认继承创建者的完整性级别（Medium），Low 客户端连上去
写请求就是"低往高写"，直接 ERROR_ACCESS_DENIED。给管道打上 **Low 完整性标签**（SDDL 里的
`S:(ML;;NW;;;LW)`）后，Low 客户端与管道同级，可写；同时 DACL 只给当前用户 + SYSTEM，别的用户
连不上。这正是 IE 保护模式当年 broker 通道的做法。

注意标签只影响"谁能写这个管道"，不影响 broker 进程自身的完整性级别（broker 是 Medium 进程，
COM 起出来的 Excel 才能是 Medium）。
"""

from __future__ import annotations

import os

PIPE_PREFIX = r"\\.\pipe"

# D: 只给 SYSTEM / Administrators / 当前用户；S: 给管道打 Low 标签，让 Low 客户端能写。
# GA=全部权限，OW=对象属主（即建管道的当前用户）。
_SDDL = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)S:(ML;;NW;;;LW)"

_PIPE_ACCESS_DUPLEX = 0x00000003
_PIPE_TYPE_BYTE = 0x00000000
_PIPE_READMODE_BYTE = 0x00000000
_PIPE_WAIT = 0x00000000
_BUF = 64 * 1024


def pipe_path(name: str) -> str:
    return rf"{PIPE_PREFIX}\{name}"


def create_server_pipe(name: str):
    """建一个带 Low 标签的命名管道，返回句柄。调用方随后 ConnectNamedPipe 等客户端。"""
    import win32pipe
    import win32security

    sa = win32security.SECURITY_ATTRIBUTES()
    sa.SECURITY_DESCRIPTOR = win32security.ConvertStringSecurityDescriptorToSecurityDescriptor(
        _SDDL, win32security.SDDL_REVISION_1,
    )
    sa.bInheritHandle = False
    return win32pipe.CreateNamedPipe(
        pipe_path(name),
        _PIPE_ACCESS_DUPLEX,
        _PIPE_TYPE_BYTE | _PIPE_READMODE_BYTE | _PIPE_WAIT,
        1,          # 单实例：一个 broker 只服务它那个会话的一个客户端，串行
        _BUF, _BUF,
        0,          # 默认超时
        sa,
    )


def wait_for_client(handle) -> None:
    import pywintypes
    import win32pipe

    try:
        win32pipe.ConnectNamedPipe(handle, None)
    except pywintypes.error as e:
        # 535 = ERROR_PIPE_CONNECTED：客户端在 ConnectNamedPipe 之前就连上了，不是错误
        if e.winerror != 535:
            raise


def disconnect_client(handle) -> None:
    """断开当前客户端，让管道回到可再次 Connect 的状态（对象表不动，Office 保持热着）。"""
    import win32pipe

    try:
        win32pipe.DisconnectNamedPipe(handle)
    except Exception:
        pass


def make_io(handle):
    """把 pywin32 句柄包成 (read_exactly, write_all) 两个函数，喂给 protocol.read_frame。"""
    import win32file

    def read_exactly(n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            try:
                _, chunk = win32file.ReadFile(handle, n - len(buf))
            except Exception:
                return buf
            if not chunk:
                return buf
            buf += chunk
        return buf

    def write_all(data: bytes) -> None:
        win32file.WriteFile(handle, data)

    return read_exactly, write_all


def random_pipe_name(session_id: str) -> str:
    """会话专属、不可猜的管道名。DACL 已经限住了用户，随机名只是再加一层。"""
    safe = "".join(c for c in (session_id or "s") if c.isalnum() or c in "-_")[:32]
    return f"ipmc-office-{safe}-{os.urandom(8).hex()}"


def wait_until_exists(name: str, timeout_sec: float = 15.0) -> bool:
    """等 broker 把管道建出来。

    起进程与建管道之间有几十到几百毫秒的空档，客户端这时去连会拿到 FileNotFoundError。由
    host 侧在注入环境变量【之前】等一下，agent 那边就永远看不到这个竞态。
    """
    import time

    import pywintypes
    import win32pipe

    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        try:
            win32pipe.WaitNamedPipe(pipe_path(name), 200)
            return True
        except pywintypes.error:
            time.sleep(0.05)
    return False
