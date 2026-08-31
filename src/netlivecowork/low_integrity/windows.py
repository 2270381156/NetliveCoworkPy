"""Windows 低完整性级别写入边界原语（Low 令牌 / 标 Low / CreateProcessAsUser + 管道适配器 / Job）。

机制与参数都在两个 spike 里实测通过（`dev/probe/win_restricted_token_spike.py`、
`dev/probe/win_low_launcher_stream_spike.py`，真实企业机）：
  - Low 令牌启动子进程 → 写工作区/共享环境通过、写别处被 OS 拒、读别处正常；
  - CreateProcessAsUser + 自建管道 + 读线程 → asyncio.StreamReader，能给上层做实时流式读。

仅 Windows 可用；`available()` 为 False 时上层应回落到内核默认执行（不进低完整性）。
pywin32 只在 Windows + 需要时导入，避免非 Windows / 无 pywin32 环境 import 崩。
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import threading

logger = logging.getLogger(__name__)

# ── Windows 常量 ───────────────────────────────────────────────────────────
CREATE_NO_WINDOW           = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_SUSPENDED           = 0x00000004
SE_GROUP_INTEGRITY         = 0x00000020
LOW_IL_SID                 = "S-1-16-4096"
ERROR_BROKEN_PIPE          = 109

_win32 = None   # 惰性加载的 pywin32 句柄集合


def available() -> bool:
    """当前是否能用 Windows 低完整性边界（Windows + pywin32 可导入）。"""
    if os.name != "nt":
        return False
    return _load() is not None


def _load():
    """惰性导入 pywin32；成功返回模块字典，失败返回 None（上层据此降级）。"""
    global _win32
    if _win32 is not None:
        return _win32 or None
    if os.name != "nt":
        _win32 = False
        return None
    try:
        import ntsecuritycon
        import pywintypes
        import win32api
        import win32con
        import win32event
        import win32file
        import win32job
        import win32process
        import win32security
        _win32 = {
            "api": win32api, "con": win32con, "event": win32event, "file": win32file,
            "job": win32job, "process": win32process, "security": win32security,
            "nt": ntsecuritycon, "types": pywintypes,
        }
    except Exception:
        _win32 = False
        return None
    return _win32


# ── Low 令牌 + 标 Low ──────────────────────────────────────────────────────
def drop_shutdown_privileges() -> None:
    """从【当前进程令牌】永久删除关机/重启特权（SE_PRIVILEGE_REMOVED），启动时调一次。

    为什么这是关机拦截的【根本】解法（而非命令词黑名单）：
    - agent 可把 ExitWindowsEx / InitiateSystemShutdownEx 写进 .py 文件跑（命令行只有 python x.py）、
      或动态拼特权/API 名（'Se'+'Shutdown'+'Privilege'）——字符串黑名单原理上抓不到。
    - 但这些 API 都需要 SeShutdownPrivilege；`AdjustTokenPrivileges` 只能【启用令牌已持有的】特权，
      特权一旦被 SE_PRIVILEGE_REMOVED 删除就【提不回来】。
    - 所有子进程（agent 的 shell，无论人工/半自动/自动；Low 令牌也是从本进程令牌复制的）都继承这个
      减权令牌 → 一处删除，【全模式、全绕过手段】都在 OS 层被拒。后端自身不需要关机权限，零副作用。

    与 Job 的 EXITWINDOWS 互补：Job 只在自动模式的 Low 子进程上、且只挡 ExitWindowsEx；本删除覆盖
    全模式且连 InitiateSystemShutdownEx 一起挡。best-effort：失败只记日志，不拖垮启动。
    """
    if not available():
        return
    SE_PRIVILEGE_REMOVED = 0x00000004
    try:
        w = _load()
        s, con, api = w["security"], w["con"], w["api"]
        th = s.OpenProcessToken(
            api.GetCurrentProcess(), con.TOKEN_ADJUST_PRIVILEGES | con.TOKEN_QUERY)
        new_state = []
        for name in ("SeShutdownPrivilege", "SeRemoteShutdownPrivilege"):
            try:
                new_state.append((s.LookupPrivilegeValue(None, name), SE_PRIVILEGE_REMOVED))
            except Exception:
                logger.debug("查特权 %s 失败，跳过", name, exc_info=True)
        if new_state:
            s.AdjustTokenPrivileges(th, False, new_state)
            logger.info("已从进程令牌删除关机/重启特权（%d 项）——全模式 OS 层禁重启/关机", len(new_state))
    except Exception:
        logger.warning("删除关机特权失败（全模式关机拦截未生效，仍有黑名单+Job 兜底）", exc_info=True)


def build_low_token():
    """复制当前进程令牌为 primary 并降到 Low 完整性级别（不删特权、不加限制 SID）。

    约束纯靠"Low 进程写不了 Medium 对象"：可写目录标 Low → 能写；其余 Medium → 写不了。
    受限令牌那条（restrict SID + WRITE_RESTRICTED）启动即 0xC0000142，已排除（spike §5.6）。
    """
    w = _load()
    s, con, nt = w["security"], w["con"], w["nt"]
    proc = s.OpenProcessToken(
        w["api"].GetCurrentProcess(),
        con.TOKEN_DUPLICATE | con.TOKEN_ASSIGN_PRIMARY | con.TOKEN_QUERY | con.TOKEN_ALL_ACCESS,
    )
    dup = s.DuplicateTokenEx(proc, s.SecurityImpersonation, con.TOKEN_ALL_ACCESS, s.TokenPrimary, None)
    low = s.ConvertStringSidToSid(LOW_IL_SID)
    s.SetTokenInformation(dup, nt.TokenIntegrityLevel, (low, SE_GROUP_INTEGRITY))
    return dup


def label_low(path: str, *, recursive: bool = True) -> None:
    """把目录标成 Low 完整性级别，让 Low 进程能写它。

    (OI)(CI) 继承 ACE 保证【此后新建】的子项自动继承 Low。
    - recursive=True（默认，加 /T）：连【已有】子文件/子目录一并重标——工作区里用户已有文件是
      Medium，不标 Low 的话 Low 进程改不了旧文件（低不能写高）。大目录慢，∝ 文件数。
    - recursive=False（不加 /T）：只标根目录本身 + 落继承 ACE，单目录、毫秒级。根下【新建】文件即
      继承 Low、可写；但【已有】旧文件仍 Medium（需随后用 recursive=True 补标）。用于"先秒切、旧文件后台慢标"。
    """
    args = ["icacls", str(path), "/setintegritylevel", "(OI)(CI)L"]
    if recursive:
        args.append("/T")
    cp = subprocess.run(
        args, capture_output=True, text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if cp.returncode != 0:
        raise RuntimeError(f"icacls 标 Low 失败 {path}: {cp.stdout.strip()} {cp.stderr.strip()}")


def is_icacls_access_denied(err_msg: str) -> bool:
    """icacls 失败信息是否为「拒绝访问」——即当前用户没权限改这个目录的完整性标签（不拥有它 /
    无 WRITE_OWNER），只有管理员能强改。icacls 输出随系统语言本地化，这里覆盖中/英两种。"""
    low = err_msg.lower()
    return "拒绝访问" in err_msg or "access is denied" in low


def find_executable_dirs(root: str, *, recursive: bool = True, dir_limit: int = 20000) -> list[str]:
    """root 下【含 .exe 的目录】清单（含 root 自身，若它直接含 .exe）。纯 os.scandir，跨平台可测。

    只收 .exe：进程的完整性级别只受【主映像文件】标签影响，.dll/.pyd/.bat/.cmd 都不会导致降级
    （.bat 由 System32 的 cmd.exe 承载，标签看的是 cmd.exe）。按【目录】收而不是按文件收，是因为
    icacls 一次只吃一个名字，但支持通配符——每个目录一条 `dir\\*.exe` 比每个文件一条快一到两个量级。

    dir_limit 是防御性上限（超大目录树不至于扫到天荒地老），命中即停并由调用方记日志。
    """
    hits: list[str] = []
    stack = [root]
    seen_dirs = 0
    while stack:
        cur = stack.pop()
        seen_dirs += 1
        if seen_dirs > dir_limit:
            break
        has_exe = False
        try:
            with os.scandir(cur) as it:
                for e in it:
                    try:
                        if e.is_file() and e.name.lower().endswith(".exe"):
                            has_exe = True
                        elif recursive and e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                    except OSError:
                        continue
        except OSError:
            continue   # 权限/竞态删除：跳过该目录，不影响其余
        if has_exe:
            hits.append(cur)
    return hits


def restore_executables_medium(root: str, *, recursive: bool = True) -> int:
    """把 root 下所有 .exe 的完整性标签还原成 Medium，返回处理过的目录数。

    【为什么必须做】Windows 新进程的完整性级别 = min(令牌 IL, 主映像文件 IL)。目录标 `(OI)(CI)L`
    会连带把里面的 .exe 也标成 Low，于是**任何**父进程（包括半自动/人工模式下的 Medium 后端）
    启动它，进程都会降级成 Low —— 而那条路径不做 env 重定向，子进程带着指向真实 %TEMP% 的环境
    以 Low 运行，写临时目录/家目录一律被系统拒（pip 的 "No usable temporary directory"、pywin32
    建 gen_py 的 WinError 5 都是这么来的）。

    【为什么不削弱边界】strict-auto 走的是 Low **令牌**，令牌 IL 更低时以令牌为准：文件标 Medium
    的 exe 用 Low 令牌启动，进程仍是 Low（已实测）。目录本身保持 Low，Low 进程照样能写。

    仅 Windows 生效；best-effort（单个目录失败只记 debug，不抛）。
    """
    if not available():
        return 0
    n = 0
    for d in find_executable_dirs(root, recursive=recursive):
        cp = subprocess.run(
            ["icacls", os.path.join(d, "*.exe"), "/setintegritylevel", "M"],
            capture_output=True, text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if cp.returncode != 0:
            logger.debug("还原 exe 为 Medium 失败（跳过）：%s %s", d, cp.stdout.strip() or cp.stderr.strip())
            continue
        n += 1
    if n:
        logger.info("已把 %d 个目录下的 .exe 还原为 Medium 标签（避免非自动模式下进程被降级）：%s", n, root)
    return n


def label_low_elevated(path: str) -> str:
    """用【管理员】权限给目录打 Low 标（弹一次 UAC）。用于普通权限 icacls 因「拒绝访问」失败的工作区
    ——用户对该目录没有改完整性标签的权限，只有管理员能强改。

    走 ShellExecuteEx "runas" 起一个提权的 icacls 进程（app 主体不提权，只有这一下是管理员），
    /T 一次性把根+已有文件全标，等它跑完。返回：
      "ok"        —— icacls 退出 0，打标成功
      "cancelled" —— 用户在 UAC 弹窗点了取消（ERROR_CANCELLED）
      "failed"    —— 提权失败 / icacls 非 0 / 超时 / 其它异常
    """
    try:
        import ctypes
        from ctypes import wintypes

        class _SEI(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
                ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR),
                ("lpParameters", wintypes.LPCWSTR), ("lpDirectory", wintypes.LPCWSTR),
                ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR),
                ("hkeyClass", wintypes.HKEY), ("dwHotKey", wintypes.DWORD),
                ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE),
            ]

        SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NO_CONSOLE, SW_HIDE, ERROR_CANCELLED = 0x40, 0x8000, 0, 1223
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        shell32.ShellExecuteExW.argtypes = [ctypes.c_void_p]
        shell32.ShellExecuteExW.restype = wintypes.BOOL
        # 句柄是 64 位，必须声明 argtypes，否则 ctypes 默认按 c_int(32 位) 截断句柄 → 等错对象。
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        sei = _SEI()
        sei.cbSize = ctypes.sizeof(sei)
        sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE
        sei.lpVerb = "runas"
        sei.lpFile = "icacls.exe"
        sei.lpParameters = f'"{path}" /setintegritylevel (OI)(CI)L /T'
        sei.nShow = SW_HIDE

        if not shell32.ShellExecuteExW(ctypes.byref(sei)):
            err = ctypes.get_last_error()
            if err == ERROR_CANCELLED:
                logger.info("提权打标：用户在 UAC 取消 %s", path)
                return "cancelled"
            logger.warning("提权打标：ShellExecuteEx 失败 err=%s %s", err, path)
            return "failed"
        if not sei.hProcess:
            return "failed"
        try:
            k32.WaitForSingleObject(sei.hProcess, 180000)   # 最多等 3 分钟（大工作区 /T 慢）
            code = wintypes.DWORD()
            k32.GetExitCodeProcess(sei.hProcess, ctypes.byref(code))
            return "ok" if code.value == 0 else "failed"
        finally:
            k32.CloseHandle(sei.hProcess)
    except Exception:
        logger.warning("提权打标异常 %s", path, exc_info=True)
        return "failed"


# ── Job Object ─────────────────────────────────────────────────────────────
def make_job(*, active_process_limit: int = 64, process_memory_mb: int | None = None):
    """进程数上限（防 fork bomb）+ KILL_ON_JOB_CLOSE（不留孤儿）+ 一组 UI 限制 + 可选单进程内存上限。

    - ActiveProcessLimit：整棵 job 内进程数上限，挡 fork bomb；
    - KILL_ON_JOB_CLOSE：句柄一关连带杀掉 job 内存活进程，会话崩溃/结束不留孤儿；
    - DIE_ON_UNHANDLED_EXCEPTION：子进程崩溃不弹「程序已停止工作」对话框（headless 沙箱免被模态框卡住）；
    - UI 限制（EXITWINDOWS 禁关机/注销 + SYSTEMPARAMETERS 禁改系统参数 + DISPLAYSETTINGS 禁改显示 +
      DESKTOP 禁建/切桌面）——这些都是命令词黑名单抓不到、Low 完整性也不拦的「捣乱系统」类操作；
      刻意【不设】HANDLES / 剪贴板 / JOB_MEMORY：会误伤 GUI 自动化 skill、剪贴板、吃内存的正常任务。
    - process_memory_mb：给了就设单进程内存上限（防死循环吃爆内存），None=不限。
    返回 job 句柄或 None。
    """
    w = _load()
    j = w["job"]
    _f = lambda name, lit: getattr(j, name, lit)   # pywin32 版本缺常量时回退字面量
    job = j.CreateJobObject(None, "")
    info = j.QueryInformationJobObject(job, j.JobObjectExtendedLimitInformation)
    flags = (j.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | j.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
             | _f("JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION", 0x00000400))
    info["BasicLimitInformation"]["ActiveProcessLimit"] = active_process_limit
    if process_memory_mb is not None:
        flags |= j.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info["ProcessMemoryLimit"] = process_memory_mb * 1024 * 1024
    info["BasicLimitInformation"]["LimitFlags"] = flags
    j.SetInformationJobObject(job, j.JobObjectExtendedLimitInformation, info)
    # UI 限制：禁关机/注销 + 禁改系统参数/显示 + 禁建切桌面。不同 pywin32 版本对这个 info 类的入参
    # 类型不一（有的要 int、有的要 dict {"UIRestrictionsClass": flag}）——传错会抛 "argument 3 must
    # be dict, not int" 并让整个 make_job 崩、连带起不了进程。这些是「便宜的额外防线」（关机另有
    # 令牌删特权 + FATAL_ONLY 黑名单兜底），故按序试 int→dict，都失败就记警告、跳过，绝不拖垮 job 主功能。
    _ui = (_f("JOB_OBJECT_UILIMIT_EXITWINDOWS", 0x80)
           | _f("JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS", 0x08)
           | _f("JOB_OBJECT_UILIMIT_DISPLAYSETTINGS", 0x10)
           | _f("JOB_OBJECT_UILIMIT_DESKTOP", 0x40))
    for _val in (_ui, {"UIRestrictionsClass": _ui}):
        try:
            j.SetInformationJobObject(job, j.JobObjectBasicUIRestrictions, _val)
            break
        except Exception:
            continue
    else:
        logger.warning("Job UI 限制(禁关机/改系统参数/改显示/切桌面) 设置失败，跳过"
                       "（关机另有令牌删特权 + FATAL_ONLY 黑名单兜底；其余捣乱类此会话本次不挡）")
    return job


def make_kill_on_close_job():
    """只带 KILL_ON_JOB_CLOSE 的 Job，不加任何 UI/资源限制。返回句柄或 None。

    给的是【自己人】辅助进程用的（Office broker），它们不是要被沙箱的对象，只是要**跟着 host
    一起死**：句柄随 host 进程退出而关闭——正常退出、被 taskkill /F、崩溃，全都算——job 里的
    进程就一并被杀。Windows 上子进程不会因为父进程没了就退出，没有这一层，host 一走它们就是
    孤儿；而 broker 在冻结态跑的就是 app 自己的 exe，孤儿会一直锁着安装目录，装新版时报
    「无法停止 IPMaster-Cowork」。

    刻意不复用 make_job：那边的 UI 限制/进程数上限是给 Low agent 子进程的，套到 broker 上只会
    平白给 COM 添麻烦。
    """
    w = _load()
    if not w:
        return None
    j = w["job"]
    try:
        job = j.CreateJobObject(None, "")
        info = j.QueryInformationJobObject(job, j.JobObjectExtendedLimitInformation)
        info["BasicLimitInformation"]["LimitFlags"] = j.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        j.SetInformationJobObject(job, j.JobObjectExtendedLimitInformation, info)
        return job
    except Exception:
        logger.warning("建 kill-on-close Job 失败（辅助进程改由父进程看门狗兜底）", exc_info=True)
        return None


def assign_pid_to_job(job, pid: int) -> bool:
    """把已在跑的进程纳入 job。失败返回 False（调用方另有兜底，不该因此起不来）。"""
    if job is None:
        return False
    w = _load()
    if not w:
        return False
    try:
        con, api = w["con"], w["api"]
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE 是 AssignProcessToJobObject 要求的最小权限
        hproc = api.OpenProcess(con.PROCESS_SET_QUOTA | con.PROCESS_TERMINATE, False, pid)
        try:
            w["job"].AssignProcessToJobObject(job, hproc)
            return True
        finally:
            api.CloseHandle(hproc)
    except Exception:
        logger.warning("把 pid=%s 纳入 Job 失败", pid, exc_info=True)
        return False


def close_job(job) -> None:
    """关闭 Job 句柄；因 KILL_ON_JOB_CLOSE，会连带杀掉 job 内仍存活的子进程（兜底清树）。"""
    if job is None:
        return
    w = _load()
    w["api"].CloseHandle(job)


# ── 管道 → asyncio.StreamReader 适配器 ──────────────────────────────────────
def _make_pipe():
    """建一对管道：写端可继承（给子进程），读端不可继承（父进程留着读）。

    关键：给管道打 **Low 完整性标签**。否则管道默认是父进程的 Medium 级别，Low 子进程往它写
    stdout/stderr 会被 MIC（强制完整性控制）拒 → 输出丢失/写失败。SDDL `S:(ML;;NW;;;LW)` =
    把对象完整性标成 Low（LW），Low 进程写 Low 对象即通过。
    """
    w = _load()
    sec = w["security"]
    sa = sec.SECURITY_ATTRIBUTES()
    sa.bInheritHandle = True
    try:
        sa.SECURITY_DESCRIPTOR = sec.ConvertStringSecurityDescriptorToSecurityDescriptor(
            "S:(ML;;NW;;;LW)", sec.SDDL_REVISION_1,
        )
    except Exception:
        logger.warning("给管道打 Low 完整性标签失败，Low 子进程可能写不出 stdout/stderr", exc_info=True)
    import win32pipe
    r, wr = win32pipe.CreatePipe(sa, 0)
    w["api"].SetHandleInformation(r, w["con"].HANDLE_FLAG_INHERIT, 0)
    return r, wr


def _pump(read_handle, reader: asyncio.StreamReader, loop: asyncio.AbstractEventLoop) -> None:
    """读线程：阻塞读管道，把字节喂进 asyncio.StreamReader；断管=EOF。"""
    w = _load()
    fmod, types = w["file"], w["types"]
    try:
        while True:
            try:
                _hr, data = fmod.ReadFile(read_handle, 65536)
            except types.error as e:
                if e.winerror == ERROR_BROKEN_PIPE:
                    break
                raise
            if not data:
                break
            loop.call_soon_threadsafe(reader.feed_data, bytes(data))
    finally:
        loop.call_soon_threadsafe(reader.feed_eof)
        try:
            fmod.CloseHandle(read_handle)
        except Exception:
            pass


class AsyncLowProcess:
    """把 CreateProcessAsUser 的 Low 进程包装成"内核 run 循环眼里的 asyncio 进程"：
    暴露 .stdout / .stderr（StreamReader）/ .pid / .returncode / await wait()。"""

    def __init__(self, hprocess, pid: int, stdout: asyncio.StreamReader, stderr: asyncio.StreamReader):
        self._h = hprocess
        self.pid = pid
        self.stdout = stdout
        self.stderr = stderr
        self.returncode: int | None = None

    async def wait(self) -> int:
        w = _load()
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, w["event"].WaitForSingleObject, self._h, w["event"].INFINITE)
        self.returncode = w["process"].GetExitCodeProcess(self._h)
        return self.returncode


async def spawn_low(command: str, *, cwd: str | None, env: dict | None, job=None) -> AsyncLowProcess:
    """用 Low 令牌启动 shell 命令，返回可异步流式读的进程包装。

    stdout/stderr 走自建管道 + 读线程 → StreamReader；进程纳入 job（若给）。命令经系统 shell
    执行（cmd /c）以支持链式/重定向，和内核默认一致。
    """
    w = _load()
    proc_mod, job_mod = w["process"], w["job"]
    loop = asyncio.get_event_loop()

    # pywin32 的 CreateProcessAsUser 构建环境块时，要求 env 的 key/value 全是 str；混进一个
    # int / None / bytes（如某个工具注入的端口号、bool 开关），它就会在解析 newEnvironment 槽位
    # 时报误导性的 "argument N must be dict, not int"。这里强转成 str 并过滤 None 值兜底。
    if env is not None:
        env = {str(k): str(v) for k, v in env.items() if v is not None}

    r_out, wr_out = _make_pipe()
    r_err, wr_err = _make_pipe()

    si = proc_mod.STARTUPINFO()
    si.dwFlags = proc_mod.STARTF_USESTDHANDLES
    si.hStdOutput = wr_out
    si.hStdError = wr_err
    # 不设 hStdInput：① 这些命令（build/test/git/脚本）都不读 stdin；② 打包（无控制台）态下
    # GetStdHandle(STD_INPUT_HANDLE) 会返回 0/无效句柄，塞进 si 反而让 CreateProcessAsUser 崩
    # （报误导性的 "argument must be dict"）；③ 只设 stdout/stderr 已实测能起进程。child 得到
    # NULL stdin，对非交互命令无影响。

    token = build_low_token()
    comspec = os.environ.get("ComSpec", "cmd.exe")
    cmdline = f'"{comspec}" /c {command}'
    # CREATE_SUSPENDED：先挂起起进程 → 纳入 job → 再 ResumeThread。否则进程在纳入 job 前就能
    # fork，逃过 job 的进程数上限/kill-on-close（§5.4 要求的启动顺序）。
    flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | (CREATE_UNICODE_ENVIRONMENT if env is not None else 0)
    try:
        hproc, hthread, pid, _tid = proc_mod.CreateProcessAsUser(
            token, None, cmdline, None, None, True, flags, env, cwd, si,  # bInheritHandles=True
        )
    except Exception:
        # 失败时把各参数类型打出来，便于在打包/真机上定位 pywin32 参数问题（不吞异常，仍抛出）。
        _bad_env = ([(k, type(v).__name__) for k, v in env.items() if not isinstance(v, str)]
                    if isinstance(env, dict) else "n/a")
        logger.error(
            "CreateProcessAsUser 失败：token=%s cmdline=%s flags=%#x(%s) env=%s env非str=%s "
            "cwd=%r(%s) si=%s",
            type(token).__name__, type(cmdline).__name__, flags, type(flags).__name__,
            type(env).__name__ if env is not None else "None", _bad_env,
            cwd, type(cwd).__name__, type(si).__name__,
        )
        raise
    # 父进程关掉写端——只剩子进程持有，退出时读端才收 EOF
    w["file"].CloseHandle(wr_out)
    w["file"].CloseHandle(wr_err)
    if job is not None:
        try:
            job_mod.AssignProcessToJobObject(job, hproc)
        except Exception:
            pass

    # 读线程先就位，再解挂——避免 resume 后早期输出在 reader 建好前丢失（管道虽有缓冲，仍求稳）。
    reader_out = asyncio.StreamReader()
    reader_err = asyncio.StreamReader()
    threading.Thread(target=_pump, args=(r_out, reader_out, loop), daemon=True).start()
    threading.Thread(target=_pump, args=(r_err, reader_err, loop), daemon=True).start()

    proc_mod.ResumeThread(hthread)   # 纳入 job 之后才真正开始跑
    w["api"].CloseHandle(hthread)
    return AsyncLowProcess(hproc, pid, reader_out, reader_err)
