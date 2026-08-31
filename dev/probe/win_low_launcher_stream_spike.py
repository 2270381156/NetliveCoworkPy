"""
Low 令牌 launcher + 管道→asyncio 流式  —— 验证脚本（一次性）

问题（对应《全自动模式安全设计》落地方案）：
  内核 run_with_liveness 是 `await proc.stdout.readline()` 逐行【实时】读。
  而 Low 子进程只能用 CreateProcessAsUser 启动，拿到的是【原始句柄】，不是 asyncio 进程。
  本 spike 验证：能不能在【纯 Python】里（不借助额外 exe）——
    1. 用 CreateProcessAsUser（Low 令牌）起进程，stdout/stderr 接到我们自建的管道；
    2. 用读线程把管道喂进 asyncio.StreamReader；
    3. 让内核那种 `await reader.readline()` 拿到【实时逐行】输出（不是憋到结束一次吐）；
    4. 顺带确认 Low 约束仍在（写工作区 OK、写工作区外被拒）、pid/退出码可拿。

判读关键：子进程每隔 1s 打一行，父进程收到每行的时间戳应【依次 +1s】——
  说明是实时流；若三行几乎同时到（都在 ~3s），说明被缓冲了、流式没成。

跑（Windows，普通用户，别用管理员）：
    pip install pywin32
    python win_low_launcher_stream_spike.py
    # 换随包 python 当子进程：
    python win_low_launcher_stream_spike.py --python "C:\\...\\python-runtime\\python.exe"
"""
from __future__ import annotations

import os
import sys
import time
import asyncio
import tempfile
import threading
import traceback

# ── 常量 ───────────────────────────────────────────────────────────────────
CREATE_NO_WINDOW           = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
SE_GROUP_INTEGRITY         = 0x00000020
LOW_IL_SID                 = "S-1-16-4096"
ERROR_BROKEN_PIPE          = 109
STREAM_CHILD               = "--stream-child"


# ══════════════════════════════════════════════════════════════════════════
# 子进程负载：纯标准库。每隔 1s 打一行（证明实时性），再测越界写。
# ══════════════════════════════════════════════════════════════════════════
def run_stream_child(inside: str, outside: str) -> int:
    for i in range(1, 4):
        print(f"line {i} @ {time.strftime('%H:%M:%S')}", flush=True)
        time.sleep(1)
    try:
        with open(inside, "w", encoding="utf-8") as f:
            f.write("x")
        print("INSIDE OK", flush=True)
    except OSError as e:
        print(f"INSIDE FAIL {type(e).__name__}:{getattr(e,'winerror',e)}", flush=True)
    try:
        with open(outside, "w", encoding="utf-8") as f:
            f.write("x")
        print("OUTSIDE WROTE(!!)", flush=True)
    except PermissionError as e:
        print(f"OUTSIDE DENIED({getattr(e,'winerror','?')})", flush=True)
    except OSError as e:
        print(f"OUTSIDE ERR {type(e).__name__}:{getattr(e,'winerror',e)}", flush=True)
    print("child done", flush=True)
    return 0


# ══════════════════════════════════════════════════════════════════════════
# 父进程（Windows 专属，仅父进程模式加载 pywin32）
# ══════════════════════════════════════════════════════════════════════════
_IS_CHILD = len(sys.argv) >= 4 and sys.argv[1] == STREAM_CHILD
if not _IS_CHILD:
    try:
        import win32api          # noqa: E402
        import win32con          # noqa: E402
        import win32event        # noqa: E402
        import win32file         # noqa: E402
        import win32pipe         # noqa: E402
        import win32process      # noqa: E402
        import win32security     # noqa: E402
        import ntsecuritycon     # noqa: E402
        import pywintypes        # noqa: E402
    except ImportError as e:
        print("✗ 缺少 pywin32（仅 Windows）。请在同一个 Python 上： python -m pip install pywin32")
        print(f"  （原始错误：{e}；解释器：{sys.executable}）")
        sys.exit(3)


def build_lowil_token():
    """把当前令牌复制为 primary 并降到 Low 完整性级别（不删特权、不加限制 SID）。"""
    proc = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(),
        win32con.TOKEN_DUPLICATE | win32con.TOKEN_ASSIGN_PRIMARY
        | win32con.TOKEN_QUERY | win32con.TOKEN_ALL_ACCESS,
    )
    dup = win32security.DuplicateTokenEx(
        proc, win32security.SecurityImpersonation,
        win32con.TOKEN_ALL_ACCESS, win32security.TokenPrimary, None,
    )
    low = win32security.ConvertStringSidToSid(LOW_IL_SID)
    win32security.SetTokenInformation(dup, ntsecuritycon.TokenIntegrityLevel, (low, SE_GROUP_INTEGRITY))
    return dup


def _make_pipe():
    """建一对管道：写端可继承（给子进程），读端不可继承（父进程留着读）。"""
    sa = win32security.SECURITY_ATTRIBUTES()
    sa.bInheritHandle = True
    r, w = win32pipe.CreatePipe(sa, 0)
    win32api.SetHandleInformation(r, win32con.HANDLE_FLAG_INHERIT, 0)  # 读端不继承
    return r, w


def _pump(read_handle, reader: asyncio.StreamReader, loop: asyncio.AbstractEventLoop):
    """读线程：阻塞读管道，把字节喂进 asyncio.StreamReader；断管=EOF。"""
    try:
        while True:
            try:
                hr, data = win32file.ReadFile(read_handle, 4096)
            except pywintypes.error as e:
                if e.winerror == ERROR_BROKEN_PIPE:
                    break            # 子进程关了写端 → EOF
                raise
            if not data:
                break
            loop.call_soon_threadsafe(reader.feed_data, bytes(data))
    finally:
        loop.call_soon_threadsafe(reader.feed_eof)
        try:
            win32file.CloseHandle(read_handle)
        except Exception:
            pass


class AsyncLowProcess:
    """把 CreateProcessAsUser 的 Low 进程，包装成"内核眼里的 asyncio 进程"。
    暴露 .stdout / .stderr（StreamReader）/ .pid / .returncode / await wait()。"""
    def __init__(self, hProcess, pid, stdout: asyncio.StreamReader, stderr: asyncio.StreamReader):
        self._h = hProcess
        self.pid = pid
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = None

    async def wait(self) -> int:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, win32event.WaitForSingleObject, self._h, win32event.INFINITE)
        self.returncode = win32process.GetExitCodeProcess(self._h)
        return self.returncode


def spawn_low(python_exe: str, cmdline: str, cwd: str, env: dict,
              loop: asyncio.AbstractEventLoop) -> AsyncLowProcess:
    """纯 Python launcher：Low 令牌 + 自建管道 + 读线程 → asyncio 流。"""
    r_out, w_out = _make_pipe()
    r_err, w_err = _make_pipe()

    si = win32process.STARTUPINFO()
    si.dwFlags = win32process.STARTF_USESTDHANDLES
    si.hStdOutput = w_out
    si.hStdError = w_err
    try:
        si.hStdInput = win32api.GetStdHandle(win32con.STD_INPUT_HANDLE)
    except Exception:
        pass

    token = build_lowil_token()
    flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    hProcess, hThread, pid, tid = win32process.CreateProcessAsUser(
        token, python_exe, cmdline, None, None, True, flags, env, cwd, si,  # bInheritHandles=True
    )
    # 父进程关掉【写端】——只剩子进程持有，子进程退出时读端才会收到 EOF
    win32file.CloseHandle(w_out)
    win32file.CloseHandle(w_err)
    win32api.CloseHandle(hThread)

    reader_out = asyncio.StreamReader()   # 在运行中的 loop 里构造 → 自动绑定当前 loop
    reader_err = asyncio.StreamReader()
    threading.Thread(target=_pump, args=(r_out, reader_out, loop), daemon=True).start()
    threading.Thread(target=_pump, args=(r_err, reader_err, loop), daemon=True).start()
    return AsyncLowProcess(hProcess, pid, reader_out, reader_err)


def _cmdline(python_exe: str, inside: str, outside: str) -> str:
    def q(s: str) -> str:
        return '"' + s.replace('"', r"\"") + '"'
    return " ".join(q(x) for x in [python_exe, os.path.abspath(__file__), STREAM_CHILD, inside, outside])


async def main_async(python_exe: str) -> int:
    loop = asyncio.get_event_loop()
    base = tempfile.mkdtemp(prefix="spike_stream_")
    workspace = os.path.join(base, "workspace"); os.makedirs(workspace)
    inside = os.path.join(workspace, "in.txt")
    outside = os.path.join(base, "OUT.txt")

    # 工作区标 Low（让 Low 子进程能写它）；TEMP 也指工作区，避免 pyc 噪音
    cp = __import__("subprocess").run(
        ["icacls", workspace, "/setintegritylevel", "(OI)(CI)L"], capture_output=True, text=True)
    if cp.returncode != 0:
        print(f"[warn] icacls 标 Low 失败：{cp.stdout} {cp.stderr}")
    env = dict(os.environ)
    env["TEMP"] = env["TMP"] = workspace
    env["PYTHONPYCACHEPREFIX"] = workspace
    env["PYTHONUNBUFFERED"] = "1"

    cmdline = _cmdline(python_exe, inside, outside)
    print(f"[parent] launch(Low): {cmdline}\n")

    proc = spawn_low(python_exe, cmdline, workspace, env, loop)

    start = loop.time()
    stamps: list[float] = []

    async def consume(reader: asyncio.StreamReader, name: str):
        while True:
            line = await reader.readline()
            if not line:
                break
            t = loop.time() - start
            text = line.decode("utf-8", errors="replace").rstrip()
            if name == "out" and text.startswith("line "):
                stamps.append(t)
            print(f"  [{t:5.1f}s] {name}: {text}")

    await asyncio.gather(consume(proc.stdout, "out"), consume(proc.stderr, "err"))
    code = await proc.wait()

    # ── 判读 ──
    print("\n" + "█" * 64)
    print(f"pid={proc.pid}  退出码=0x{code & 0xFFFFFFFF:08X}")
    print(f"写工作区内 in.txt 存在？ {'OK' if os.path.exists(inside) else '未写'}")
    print(f"写工作区外 OUT.txt 存在？ {'WROTE(!!)' if os.path.exists(outside) else 'DENIED（符合预期）'}")
    live = len(stamps) >= 3 and (stamps[-1] - stamps[0]) >= 1.5  # 三行跨度≥1.5s ≈ 实时
    print(f"三行到达时间戳：{[round(s,1) for s in stamps]}")
    print(f"实时流式？ {'✅ 是（逐行 ~1s 依次到）' if live else '❌ 否（疑似被缓冲，几乎同时到）'}")
    print("█" * 64)
    print("\n判读：")
    print("  • 实时流式=是 且 写工作区内 OK 且 写工作区外 DENIED → 纯 Python launcher 可行，无需额外 exe")
    print("  • 实时流式=否 → 输出被缓冲，需检查管道/StreamReader 接法（或子进程未 flush）")
    return 0


def main() -> int:
    if os.name != "nt":
        print("此 spike 只能在 Windows 上跑。当前平台:", os.name)
        return 2
    python_exe = sys.executable
    if "--python" in sys.argv:
        python_exe = sys.argv[sys.argv.index("--python") + 1]
    print(f"[spike] 子进程解释器: {python_exe}\n")
    try:
        return asyncio.run(main_async(python_exe))
    except Exception as e:
        print(f"[spike] 崩溃: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    if _IS_CHILD:
        sys.exit(run_stream_child(sys.argv[2], sys.argv[3]))
    sys.exit(main())
