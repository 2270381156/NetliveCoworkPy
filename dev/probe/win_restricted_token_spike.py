"""
Windows 受限令牌沙箱 —— 环境验证 spike（一次性诊断脚本，用完即弃）

目的（对应《全自动模式安全设计》§5.6②）：在【目标 Windows 环境】上确认——
  1. 普通（非服务）进程能否用【自派生受限令牌】启动子进程；
  2. 受限令牌 + WRITE_RESTRICTED + ACL 是否真的做到：
       · 写【工作区】     → 通过
       · 写【共享环境目录】→ 通过（模拟 venv / node，可写）
       · 写【工作区外】   → 被拒
       · 读【工作区外】   → 正常（WRITE_RESTRICTED 只卡写、不卡读）
  3. 哪个进程创建 API 走得通：CreateProcessAsUser / CreateProcessWithTokenW。

核心机制是成熟的（Chromium 沙箱多年生产做法）；本脚本不是验证「能不能用」，
而是排本环境的雷：企业 EDR / 杀软 / 组策略、pywin32 细节。

完整性级别（Low IL）已排出 MVP，默认不测；加 --test-low 可顺带跑一个 Low 场景，
为将来加固留数据（会告诉你 Low 下随包 Python 起不起得来）。

────────────────────────────────────────────────────────────────────────
怎么跑（Windows，普通用户即可，【不要】用管理员——那样测不出真实约束）：

    pip install pywin32
    python win_restricted_token_spike.py

    # 随包 Python 在 Low IL 下能否启动：
    python win_restricted_token_spike.py --python "C:\\...\\python-runtime\\python.exe"
    # 逐个验 cmd / powershell / node 在 Low IL 下能否启动 + 越界写是否被拒（PowerShell 是重点）：
    python win_restricted_token_spike.py --test-interp
    # 受限令牌逐项排查（已知启动失败 0xC0000142，仅作对照）：
    python win_restricted_token_spike.py --test-restricted

关注输出矩阵：受限场景应
    inside=OK  shared_env=OK  outside_write=DENIED  outside_read=OK
启动 API 落在 CreateProcessAsUser 最好；落在 WithTokenW 则记进设计；两者都失败
大概率是 EDR / 组策略拦截，需换环境 / 调策略 / 走 AppContainer。

这是诊断脚本：某个 pywin32 签名在你的版本上不一致时，对应步骤会打完整 traceback，
就地修即可——目标是拿到那张矩阵，不是一次跑通。
────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import os
import sys
import json
import tempfile
import subprocess
import traceback

# ── Windows 常量 ───────────────────────────────────────────────────────────
DISABLE_MAX_PRIVILEGE = 0x1          # 删除除 SeChangeNotify 外的全部特权
WRITE_RESTRICTED      = 0x8          # 第二遍检查只卡「写」，读走正常检查
CREATE_SUSPENDED      = 0x00000004
CREATE_NO_WINDOW      = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
SE_GROUP_LOGON_ID     = 0xC0000000   # token group 属性：登录会话 SID
SE_GROUP_INTEGRITY    = 0x00000020
LOW_IL_SID            = "S-1-16-4096"
ERROR_PRIVILEGE_NOT_HELD = 1314

CHILD_MARK = "--child"   # 子进程负载模式触发参数


# ══════════════════════════════════════════════════════════════════════════
# 子进程负载：纯标准库（不 import pywin32），以便把子进程换成【随包 Python】测启动。
# 结果写进【工作区内】的 result.json（工作区可写，受限场景也能写回来给父进程读）。
# ══════════════════════════════════════════════════════════════════════════
def run_child(spec_path: str) -> int:
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    result = {"pid": os.getpid(), "python": sys.executable}

    def do_write(path: str) -> str:
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("spike")
            return "OK"
        except PermissionError as e:
            return f"DENIED({getattr(e,'winerror','?')})"
        except OSError as e:
            return f"ERROR({type(e).__name__}:{getattr(e,'winerror',e)})"

    def do_read(path: str) -> str:
        try:
            with open(path, encoding="utf-8") as fh:
                fh.read()
            return "OK"
        except PermissionError as e:
            return f"DENIED({getattr(e,'winerror','?')})"
        except OSError as e:
            return f"ERROR({type(e).__name__}:{getattr(e,'winerror',e)})"

    result["write_inside"]    = do_write(spec["inside"])
    result["write_shared"]    = do_write(spec["shared"])
    result["modify_existing"] = do_write(spec["existing"])   # 改工作区里【已有】文件（父进程预建的 Medium 文件）
    result["write_outside"]   = do_write(spec["outside"])
    result["read_outside"]    = do_read(spec["outside_read"])

    # 结果写回工作区（父进程从这里读——受限场景拿不到子进程 stdout）
    with open(spec["result"], "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    print("[child]", result, flush=True)
    return 0


# ══════════════════════════════════════════════════════════════════════════
# 父进程
# ══════════════════════════════════════════════════════════════════════════
# pywin32 只有【父进程】用；子进程负载是纯标准库，以便用【随包 Python】（无 pywin32）当子进程。
# 故 pywin32 的导入放这里、仅父进程模式加载——否则子进程会在导入时就崩，友好提示也拦不住。
_IS_CHILD = len(sys.argv) >= 3 and sys.argv[1] == CHILD_MARK
HAS_JOB = False
if not _IS_CHILD:
    try:
        import win32api          # noqa: E402
        import win32con          # noqa: E402
        import win32event        # noqa: E402
        import win32file         # noqa: E402
        import win32process      # noqa: E402
        import win32security     # noqa: E402
        import win32service      # noqa: E402
        import ntsecuritycon     # noqa: E402
    except ImportError as e:
        print("✗ 缺少 pywin32（仅 Windows 可用）。请在【将要运行本脚本的同一个】Python 上安装：")
        print("      python -m pip install pywin32")
        print("  装完若仍报错，执行一次： python -m pywin32_postinstall -install")
        print(f"  （原始错误：{e}）")
        print(f"  （当前解释器：{sys.executable}）")
        sys.exit(3)
    try:
        import win32job          # noqa: E402
        HAS_JOB = True
    except Exception:
        HAS_JOB = False


def _icacls(*args: str) -> None:
    cp = subprocess.run(["icacls", *args], capture_output=True, text=True)
    if cp.returncode != 0:
        raise RuntimeError(f"icacls {args} 失败: {cp.stdout.strip()} {cp.stderr.strip()}")


def get_logon_sid(token):
    """从令牌组里取登录会话 SID —— 作 restricting SID + 可写目录的授权对象。"""
    for sid, attr in win32security.GetTokenInformation(token, ntsecuritycon.TokenGroups):
        if (attr & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID:
            return sid
    raise RuntimeError("令牌里找不到登录会话 SID（SE_GROUP_LOGON_ID）")


def build_restricted_token(*, restrict_sid=True, write_restricted=True,
                           disable_priv=True, disable_admin=True):
    """四个开关可单独开关，用于逐项排查 0xC0000142 到底是哪个开关引起的：
      restrict_sid     : SidsToRestrict=[登录 SID]（+ write_restricted 才构成"只能写授权目录"）
      write_restricted : WRITE_RESTRICTED（第二遍检查只卡写）
      disable_priv     : DISABLE_MAX_PRIVILEGE（删特权）
      disable_admin    : SidsToDisable=[Administrators]
    """
    proc_token = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(),
        win32con.TOKEN_DUPLICATE | win32con.TOKEN_ASSIGN_PRIMARY
        | win32con.TOKEN_QUERY | win32con.TOKEN_ALL_ACCESS,
    )
    logon_sid = get_logon_sid(proc_token)
    admins = win32security.CreateWellKnownSid(win32security.WinBuiltinAdministratorsSid, None)
    flags = (DISABLE_MAX_PRIVILEGE if disable_priv else 0) | (WRITE_RESTRICTED if write_restricted else 0)
    restricted = win32security.CreateRestrictedToken(
        proc_token, flags,
        [(admins, 0)] if disable_admin else [],
        [],                                       # PrivilegesToDelete：交给 DISABLE_MAX_PRIVILEGE
        [(logon_sid, 0)] if restrict_sid else [],
    )
    return restricted, logon_sid


def grant_writable(path: str, logon_sid, low_il: bool) -> None:
    """把 path 加入可写集：授权登录会话 SID 可写；Low 场景再标 Low。"""
    sidstr = win32security.ConvertSidToStringSid(logon_sid)
    _icacls(path, "/grant", f"*{sidstr}:(OI)(CI)(F)")
    if low_il:
        _icacls(path, "/setintegritylevel", "(OI)(CI)L")


def build_lowil_token():
    """仅把当前令牌降到 Low 完整性级别——不删特权、不加限制 SID、不 WRITE_RESTRICTED。
    进程仍以本人身份跑（能正常连 CSRSS / 桌面，不踩受限令牌的初始化坑），
    约束纯靠"Low 进程写不了 Medium 对象"：可写目录标 Low → 能写；其余 Medium → 写不了。"""
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


def label_low(path: str) -> None:
    """把目录标成 Low 完整性级别，让 Low 进程能写它（可写集）。
    /T 递归 → 让工作区里【已有】文件也变 Low（否则 Low 进程改不了旧文件：低不能写高）。"""
    _icacls(path, "/setintegritylevel", "(OI)(CI)L", "/T")


# ── 窗口站 / 桌面授权 ──────────────────────────────────────────────────────
# 受限令牌的登录会话 SID 默认访问不了 winsta0\default，user32.dll 初始化失败 →
# 子进程以 0xC0000142(DLL_INIT_FAILED) 死在启动阶段。Chromium 沙箱同款修法：
# 把该 SID 授权到当前窗口站（含可继承 ACE，让子桌面对象继承）和当前桌面。
WINSTA_ALL_ACCESS  = 0x0000037F
DESKTOP_ALL_ACCESS = 0x000001FF
GENERIC_ALL        = 0x10000000
OBJECT_INHERIT_ACE       = 0x1
CONTAINER_INHERIT_ACE    = 0x2
NO_PROPAGATE_INHERIT_ACE = 0x4
INHERIT_ONLY_ACE         = 0x8


def _grant_window_object(handle, sid, access, inheritable):
    sd = win32security.GetSecurityInfo(
        handle, win32security.SE_WINDOW_OBJECT, win32security.DACL_SECURITY_INFORMATION)
    dacl = sd.GetSecurityDescriptorDacl() or win32security.ACL()
    if inheritable:
        # 一条作用于对象本身（不向下传播），一条只作用于子对象（桌面）
        dacl.AddAccessAllowedAceEx(win32security.ACL_REVISION, NO_PROPAGATE_INHERIT_ACE, access, sid)
        dacl.AddAccessAllowedAceEx(
            win32security.ACL_REVISION,
            CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE | OBJECT_INHERIT_ACE, GENERIC_ALL, sid)
    else:
        dacl.AddAccessAllowedAce(win32security.ACL_REVISION, access, sid)
    win32security.SetSecurityInfo(
        handle, win32security.SE_WINDOW_OBJECT, win32security.DACL_SECURITY_INFORMATION,
        None, None, dacl, None)


def grant_winsta_desktop(logon_sid) -> None:
    winsta = win32service.GetProcessWindowStation()
    _grant_window_object(winsta, logon_sid, WINSTA_ALL_ACCESS, inheritable=True)
    desktop = win32service.GetThreadDesktop(win32api.GetCurrentThreadId())
    _grant_window_object(desktop, logon_sid, DESKTOP_ALL_ACCESS, inheritable=False)


def make_job():
    if not HAS_JOB:
        return None
    job = win32job.CreateJobObject(None, "")
    info = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    info["BasicLimitInformation"]["LimitFlags"] = (
        win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | win32job.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
    )
    info["BasicLimitInformation"]["ActiveProcessLimit"] = 16
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, info)
    return job


def _inheritable_log(log_path: str):
    """父进程打开一个可继承的日志句柄——句柄在 open 时就拿到写权限，
    子进程即便被降权，也能通过这个继承来的句柄写出它的 stdout/stderr（诊断关键）。"""
    sa = win32security.SECURITY_ATTRIBUTES()
    sa.bInheritHandle = True
    return win32file.CreateFile(
        log_path, win32file.GENERIC_WRITE,
        win32file.FILE_SHARE_READ | win32file.FILE_SHARE_WRITE, sa,
        win32file.CREATE_ALWAYS, 0, None,
    )


def launch_as_user(token, python_exe, cmdline, cwd, job, log_path, env=None):
    """首选：CreateProcessAsUser。顺序 CREATE_SUSPENDED → assign → resume。
    把子进程 stdout/stderr 重定向到父进程打开的日志，拿到死因与退出码。
    env 非 None 时用作子进程环境（Low IL 场景重定向 TEMP/缓存到可写目录）。"""
    h = _inheritable_log(log_path)
    si = win32process.STARTUPINFO()
    si.dwFlags = win32process.STARTF_USESTDHANDLES
    si.hStdOutput = h
    si.hStdError = h
    try:
        si.hStdInput = win32api.GetStdHandle(win32con.STD_INPUT_HANDLE)
    except Exception:
        pass
    flags = CREATE_SUSPENDED | CREATE_NO_WINDOW
    if env is not None:
        flags |= CREATE_UNICODE_ENVIRONMENT
    hProc, hThread, pid, tid = win32process.CreateProcessAsUser(
        token, python_exe, cmdline, None, None, True, flags, env, cwd, si   # bInheritHandles=True
    )
    if job is not None:
        win32job.AssignProcessToJobObject(job, hProc)
    win32process.ResumeThread(hThread)
    win32event.WaitForSingleObject(hProc, 30_000)
    code = win32process.GetExitCodeProcess(hProc)
    try:
        win32file.CloseHandle(h)
    except Exception:
        pass
    return code


def launch_with_token_w(token, python_exe, cmdline, cwd):
    """退路：CreateProcessWithTokenW（pywin32 未包装，用 ctypes）。需 SeImpersonate。"""
    import ctypes
    from ctypes import wintypes

    class STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
            ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
            ("hStdError", wintypes.HANDLE),
        ]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
            ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
        ]

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    LOGON_WITH_PROFILE = 0x00000001

    si = STARTUPINFOW(); si.cb = ctypes.sizeof(STARTUPINFOW)
    pi = PROCESS_INFORMATION()
    ok = advapi32.CreateProcessWithTokenW(
        wintypes.HANDLE(int(token)), LOGON_WITH_PROFILE,
        wintypes.LPCWSTR(python_exe), ctypes.create_unicode_buffer(cmdline),
        wintypes.DWORD(CREATE_NO_WINDOW), None,
        wintypes.LPCWSTR(cwd), ctypes.byref(si), ctypes.byref(pi),
    )
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    kernel32.WaitForSingleObject(pi.hProcess, 30_000)
    code = wintypes.DWORD()
    kernel32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    kernel32.CloseHandle(pi.hProcess); kernel32.CloseHandle(pi.hThread)
    return code.value


def _cmdline(python_exe: str, spec_path: str) -> str:
    def q(s: str) -> str:
        return '"' + s.replace('"', r"\"") + '"'
    return " ".join(q(x) for x in [python_exe, os.path.abspath(__file__), CHILD_MARK, spec_path])


def run_scenario(name: str, *, mech: str, use_job: bool, python_exe: str, ropts: dict | None = None) -> dict:
    """mech: 'baseline'（普通 subprocess）| 'restricted'（受限令牌）| 'lowil'（仅 Low 完整性级别）
    ropts: mech='restricted' 时的令牌开关（见 build_restricted_token），用于逐项排查启动失败。"""
    print("\n" + "═" * 70 + f"\n场景：{name}\n" + "═" * 70)
    res = {"name": name, "launch_api": None, "child": None, "error": None, "exit_code": None}

    base = tempfile.mkdtemp(prefix="spike_")
    workspace = os.path.join(base, "workspace"); os.makedirs(workspace)
    shared    = os.path.join(base, "shared_env"); os.makedirs(shared)   # 模拟共享 venv/node，应可写
    outside   = os.path.join(base, "OUTSIDE.txt")                        # 工作区外，普通用户本可写
    result    = os.path.join(workspace, "__result.json")                # 子进程把结果写这（工作区内）

    # 预先造一个「工作区外」文件，供子进程测【读】——读应成功、写应被拒
    with open(outside + ".readme", "w", encoding="utf-8") as f:
        f.write("readable")
    # 预先在工作区里造一个【已有】文件（父进程=Medium 创建），测 Low 子进程能否改它
    existing = os.path.join(workspace, "existing.txt")
    with open(existing, "w", encoding="utf-8") as f:
        f.write("old")

    spec = {"inside": os.path.join(workspace, "in.txt"),
            "shared": os.path.join(shared, "pkg.txt"),
            "existing": existing,
            "outside": outside, "outside_read": outside + ".readme",
            "result": result}
    spec_path = os.path.join(base, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f)

    child_log = os.path.join(base, "child_stdio.txt")
    cmd = _cmdline(python_exe, spec_path)
    try:
        if mech == "baseline":
            cp = subprocess.run([python_exe, os.path.abspath(__file__), CHILD_MARK, spec_path],
                                capture_output=True, text=True, timeout=30)
            print(cp.stdout, cp.stderr)
            res["launch_api"] = "subprocess(baseline)"

        elif mech == "lowil":
            token = build_lowil_token()
            label_low(workspace); label_low(shared)        # 标 Low → Low 进程能写
            env = dict(os.environ)                          # Low 写不了 Medium 的 %TEMP% → 重定向到工作区
            env["TEMP"] = env["TMP"] = workspace
            env["PYTHONPYCACHEPREFIX"] = workspace
            job = make_job() if use_job else None
            print(f"[parent] launch(lowil): {cmd}")
            res["exit_code"] = launch_as_user(token, python_exe, cmd, workspace, job, child_log, env)
            res["launch_api"] = "CreateProcessAsUser(LowIL)"

        else:  # restricted
            opts = ropts or dict(restrict_sid=True, write_restricted=True,
                                 disable_priv=True, disable_admin=True)
            print(f"[parent] 令牌开关: {opts}")
            token, logon_sid = build_restricted_token(**opts)
            grant_writable(workspace, logon_sid, False)
            grant_writable(shared, logon_sid, False)
            try:
                grant_winsta_desktop(logon_sid)             # 否则子进程 0xC0000142 死在启动
            except Exception as e:
                print(f"[parent] 窗口站/桌面授权失败（可能 pywin32 签名不符，请贴出）: {e}")
                traceback.print_exc()
            job = make_job() if use_job else None
            print(f"[parent] launch(restricted): {cmd}")
            try:
                res["exit_code"] = launch_as_user(token, python_exe, cmd, workspace, job, child_log)
                res["launch_api"] = "CreateProcessAsUser"
            except Exception as e:
                werr = getattr(e, "winerror", None)
                print(f"[parent] CreateProcessAsUser 失败 (winerror={werr}): {e} → 试 WithTokenW")
                res["exit_code"] = launch_with_token_w(token, python_exe, cmd, workspace)
                res["launch_api"] = "CreateProcessWithTokenW"

        if mech != "baseline":
            ec = res.get("exit_code")
            ecs = f"0x{ec & 0xFFFFFFFF:08X}" if isinstance(ec, int) else str(ec)
            print(f"[parent] 子进程退出码 = {ecs}")
            if os.path.exists(child_log):
                with open(child_log, encoding="utf-8", errors="replace") as f:
                    out = f.read().strip()
                print("[parent] 子进程输出:\n" + (out or "（空——进程可能在跑到 Python 代码前就退了）"))

        # 从工作区里的 result.json 读子进程结果
        if os.path.exists(result):
            with open(result, encoding="utf-8") as f:
                res["child"] = json.load(f)
        else:
            res["error"] = "子进程未写出 result.json（可能没起来——看上面报错）"
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()

    print(f"[parent] {res['launch_api']} | child={res['child']} | err={res['error']}")
    return res


def _interp_cmdline(interp: str, inside: str, outside: str) -> str:
    """某解释器"写工作区内 + 写工作区外"的一条命令。父进程按文件是否被写判定。"""
    fwd = lambda p: p.replace("\\", "/")   # node 在 JS 字符串里要正斜杠（反斜杠是转义符）
    if interp == "cmd":
        return f'cmd /c echo x> "{inside}" & echo x> "{outside}"'
    if interp == "powershell":
        return (f'powershell -NoProfile -NonInteractive -Command '
                f'"Set-Content -LiteralPath \'{inside}\' -Value x; '
                f'Set-Content -LiteralPath \'{outside}\' -Value x"')
    if interp == "node":
        return (f'node -e "const fs=require(\'fs\');'
                f'fs.writeFileSync(\'{fwd(inside)}\',\'x\');'
                f'fs.writeFileSync(\'{fwd(outside)}\',\'x\')"')
    raise ValueError(interp)


def _run_one_interp(interp: str, python_exe: str) -> dict:
    """用 Low 令牌启动某个解释器，验证：能否启动 + 工作区内写通过 + 工作区外写被拒。"""
    print("\n" + "═" * 70 + f"\n解释器：{interp}\n" + "═" * 70)
    res = {"name": interp, "exit_code": None, "inside": "-", "outside": "-", "error": None}
    base = tempfile.mkdtemp(prefix="spike_i_")
    workspace = os.path.join(base, "workspace"); os.makedirs(workspace)
    inside = os.path.join(workspace, "in.txt")
    outside = os.path.join(base, "OUT.txt")
    child_log = os.path.join(base, "log.txt")
    try:
        label_low(workspace)
        token = build_lowil_token()
        env = dict(os.environ); env["TEMP"] = env["TMP"] = workspace
        env["PYTHONPYCACHEPREFIX"] = workspace
        cmdline = _interp_cmdline(interp, inside, outside)
        print(f"[parent] launch({interp}): {cmdline}")
        # appName=None → 从 cmdline 解析可执行文件（cmd/powershell/node 在 PATH 上）
        res["exit_code"] = launch_as_user(token, None, cmdline, workspace, None, child_log, env)
        res["inside"] = "OK" if os.path.exists(inside) else "未写"
        res["outside"] = "WROTE(!!)" if os.path.exists(outside) else "DENIED"
        ec = res["exit_code"]
        print(f"[parent] 退出码 = 0x{ec & 0xFFFFFFFF:08X}" if isinstance(ec, int) else f"退出码={ec}")
        if os.path.exists(child_log):
            with open(child_log, encoding="utf-8", errors="replace") as f:
                out = f.read().strip()
            if out:
                print("[parent] 输出:\n" + out)
    except Exception as e:
        res["error"] = f"启动失败（可能未安装 {interp}）: {e}"
        print(f"[parent] {res['error']}")
    return res


def main() -> int:
    if os.name != "nt":
        print("此 spike 只能在 Windows 上跑。当前平台:", os.name)
        return 2

    python_exe = sys.executable
    if "--python" in sys.argv:
        python_exe = sys.argv[sys.argv.index("--python") + 1]
    test_restricted = "--test-restricted" in sys.argv  # 受限令牌路子（已知易踩 0xC0000142，默认不跑）
    test_interp = "--test-interp" in sys.argv           # 在 Low IL 下逐个验 cmd/powershell/node
    print(f"[spike] 子进程解释器: {python_exe}  test_restricted={test_restricted}  test_interp={test_interp}")

    scenarios = [
        ("基线（普通令牌）",          dict(mech="baseline", use_job=False)),
        ("Low IL（首选机制）",        dict(mech="lowil",    use_job=False)),
        ("Low IL + Job",            dict(mech="lowil",    use_job=True)),
    ]
    if test_restricted:
        # 逐项排查：把四个开关拆开单独试，看哪个开关导致 0xC0000142。
        # 关键看 V2（restrict+WR，我们真正需要的约束）能不能启动。
        scenarios += [
            ("受限 V1 全开",          dict(mech="restricted", use_job=False,
                ropts=dict(restrict_sid=True,  write_restricted=True,  disable_priv=True,  disable_admin=True))),
            ("受限 V2 仅restrict+WR", dict(mech="restricted", use_job=False,
                ropts=dict(restrict_sid=True,  write_restricted=True,  disable_priv=False, disable_admin=False))),
            ("受限 V3 仅删特权",       dict(mech="restricted", use_job=False,
                ropts=dict(restrict_sid=False, write_restricted=False, disable_priv=True,  disable_admin=False))),
            ("受限 V4 仅禁Admin",     dict(mech="restricted", use_job=False,
                ropts=dict(restrict_sid=False, write_restricted=False, disable_priv=False, disable_admin=True))),
        ]

    results = []
    for nm, kw in scenarios:
        try:
            results.append(run_scenario(nm, python_exe=python_exe, **kw))
        except Exception as e:
            print(f"[spike] 场景 {nm} 崩溃: {e}"); traceback.print_exc()

    # ── 解释器矩阵（Low IL 下 cmd/powershell/node 能否启动 + 越界写是否被拒）──
    interp_results = []
    if test_interp:
        for interp in ("cmd", "powershell", "node"):
            try:
                interp_results.append(_run_one_interp(interp, python_exe))
            except Exception as e:
                print(f"[spike] 解释器 {interp} 崩溃: {e}"); traceback.print_exc()

    # ── 汇总矩阵 ──
    print("\n" + "█" * 82)
    print("汇总（隔离场景应：inside=OK shared=OK outside_write=DENIED outside_read=OK）")
    print("█" * 82)
    hdr = (f"{'场景':<20}{'退出码':<12}{'inside':<7}{'shared':<7}"
           f"{'改旧文件':<10}{'out_write':<14}{'out_read'}")
    print(hdr)
    for r in results:
        c = r["child"] or {}
        ec = r.get("exit_code")
        ecs = f"0x{ec & 0xFFFFFFFF:08X}" if isinstance(ec, int) else "-"
        print(f"{r['name']:<20}{ecs:<12}"
              f"{str(c.get('write_inside','-')):<7}{str(c.get('write_shared','-')):<7}"
              f"{str(c.get('modify_existing','-')):<10}"
              f"{str(c.get('write_outside','-')):<14}{str(c.get('read_outside','-'))}")
        if r["error"]:
            print(f"    ! {r['error']}")

    if interp_results:
        print("\n解释器矩阵（Low IL 下，应 inside=OK 且 outside=DENIED）：")
        print(f"  {'解释器':<12}{'退出码':<12}{'inside':<8}{'outside'}")
        for r in interp_results:
            ec = r.get("exit_code")
            ecs = f"0x{ec & 0xFFFFFFFF:08X}" if isinstance(ec, int) else "-"
            print(f"  {r['name']:<12}{ecs:<12}{r['inside']:<8}{r['outside']}")
            if r["error"]:
                print(f"    ! {r['error']}")

    print("\n判读：")
    print("  • Low IL：inside=OK shared=OK out_write=DENIED out_read=OK → 该机制成立")
    print("  • 受限令牌逐项排查（--test-restricted，退出码 0=正常起来，0xC0000142=启动失败）：")
    print("      - V2(仅 restrict+WR) 能起来 → 约束机制本身可行，V1 的失败来自删特权/禁Admin，放宽即可")
    print("      - V2 也 0xC0000142       → 是 restrict SID/WRITE_RESTRICTED 导致，需补授权启动对象(下一步)")
    print("      - V3/V4 能起、V2 不能     → 进一步印证问题出在 restrict SID 这一项")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == CHILD_MARK:
        sys.exit(run_child(sys.argv[2]))
    sys.exit(main())
