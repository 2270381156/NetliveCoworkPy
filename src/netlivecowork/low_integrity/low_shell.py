"""低完整性 shell 处理器：strict-auto + Windows 会话走 Low 令牌执行，其余委托内核默认 shell。

内核不动，故这里把内核 `shell()` 生成器"抄"一份（venv 引导 / 黑名单 / 超时 / 流式全部
复用内核的纯 helper，只是 import），唯二差别：
  1. 起进程用 `run_low_with_liveness`（Low 令牌，写受限）而非内核的 `run_with_liveness`；
  2. env 再叠一层 `redirect_env`——把临时/家目录/AppData 都指到Low 目录，
     免得子进程写默认位置（Medium 的系统 %TEMP% / 用户 AppData）被 OS 拒。

`make_shell_invoker` 产出的 invoker 与内核同签名 `(args, ctx) -> AsyncIterator[CapabilityEvent]`：
非低完整性会话直接委托内核 invoker（零行为差异），低完整性会话才进 Low 路径。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import AsyncIterator, Callable

from ctx_weft.protocols.capability import CapabilityEvent
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers.capability_filesystem._bash_safety import check_command_safety
from ctx_weft.providers.capability_filesystem._venv import (
    VenvError,
    command_is_python,
    ensure_venv,
    venv_env,
    venv_layout,
)

from netlivecowork.low_integrity import windows
from netlivecowork.low_integrity.env import LowIntegrityLayout, redirect_env
from netlivecowork.low_integrity.low_runner import run_low_with_liveness
from netlivecowork.office_broker import manager as office_manager

logger = logging.getLogger(__name__)

# 与内核 provider 同一套默认（内核未导出常量，这里对齐取值；ctx.extra 里通常已由 provider 注入）。
_BASH_IDLE_TIMEOUT_SEC_DEFAULT = 30
_BASH_HARD_CAP_SEC_DEFAULT = 3600
_BASH_MAX_OUTPUT_BYTES_DEFAULT = 50_000

# "越界写被 OS 拒"的迹象：Low 子进程写工作区外会得到这些拒绝访问类报错。命中就给模型追加一句
# 边界解释——否则它只看到原始 PermissionError/WinError 5，可能不明就里地反复重试。
_BOUNDARY_DENIAL_MARKERS = (
    "permission denied", "errno 13", "winerror 5", "access is denied",
    "access denied", "拒绝访问",
    # 子进程连一个可写的临时目录都找不到：TEMP 已被指向 Low 目录，还报这个，说明它在往工作区外
    # 的目录里找落脚点（pip 的 build tracker、tempfile.gettempdir 都会这样报）。不给提示的话模型
    # 只看到一坨 traceback，会原地重试。
    "no usable temporary directory",
)
_BOUNDARY_HINT = (
    "\n\n[自动模式提示] 上面的写入/访问失败，很可能是目标在【工作区外】——自动模式下工作区外"
    "不可写（由系统层拦截，不是命令本身的错）。请把文件写到工作区内（用相对路径，或工作区内的"
    "绝对路径）后重试。"
)

# "缺系统级特权"的迹象：关机/重启特权已从令牌删除，任何关机/改系统特权的调用（含 ctypes 直调
# InitiateSystemShutdownEx 等）会得到 ERROR_PRIVILEGE_NOT_HELD(1314)/"所需的特权"。命中就明确告诉
# 模型「系统级操作被禁、别再试」——覆盖字符串黑名单抓不到的动态关机方式。
_PRIVILEGE_DENIAL_MARKERS = (
    "所需的特权", "privilege not held", "a required privilege", "not all privileges", "1314",
)
_PRIVILEGE_HINT = (
    "\n\n[系统提示] 上面的操作因【缺少系统级特权】失败——关机 / 重启 / 改系统特权这类操作已被禁用，"
    "无法执行、也无法通过提权取得。请不要再尝试任何关闭或重启本机、修改系统特权的操作，"
    "回到用户交代的实际任务上。"
)


# ── Office 相关的三种失败，各自认各自的迹象、各贴各的提示 ──────────────────────
# 以前是一条 _COM_HINT 打天下：只要输出里出现 `com_error` 就贴上"代理没生效 + 可能没装 Office +
# 顺带讲写边界"整段。于是 Excel 说一句"找不到文件"，模型也会被告知"可能没装 Office"，然后跑去
# 装 Office / 改写路径，越走越偏。现在三件事分开认、分开说，且互斥（见 failure_hint）。

# ① 代理没生效：桩连不上 broker，或 agent 绕开桩直接用 win32com——后者在 Low 下 DCOM 会让
# Dispatch 出来的 EXCEL.EXE 跟着降级，连临时文件都写不了，报错还伪装成"内存或磁盘空间不足"。
_NO_BROKER_MARKERS = (
    "没有 office broker", "连不上 office broker", "office broker 连接已断开",
    "office_launch_failed", "server execution failed", "服务器执行失败",
    "内存或磁盘空间不足", "-2146959355",
)
_NO_BROKER_HINT = (
    "\n\n[自动模式提示] 上面这次 Office 自动化没走通代理。正常情况下本应用会把 `win32com.client` "
    "透明代理到应用侧的 broker 进程（低完整性进程自己起不了 Office），你按平时的写法用就行；"
    "会看到这条说明这次代理没生效或 broker 没起来。"
    "\n先改用纯文件库绕过（openpyxl / python-docx / python-pptx / pandas）；非 Office 不可的话，"
    "把这个情况告诉用户。"
)

# ② 本机没装：broker 已经把 COM 类未注册单独分了码，这里认那个码即可。
_NOT_INSTALLED_MARKERS = ("office_not_installed",)
_NOT_INSTALLED_HINT = (
    "\n\n[自动模式提示] 本机没有装这个 Office 应用。这不是权限问题、也不是工作区边界问题，"
    "换写法或重试都不会好。请改用纯文件库（openpyxl / python-docx / python-pptx / pandas）完成任务；"
    "确实非它不可，就把「本机没装」这件事告诉用户。"
)

# ③ Office 写到了工作区外：闸门拦下的，和 ①② 无关，也和 OS 层的拒绝访问（_BOUNDARY_HINT）不同。
_OFFICE_WRITE_MARKERS = ("write_outside_workspace",)
_OFFICE_WRITE_HINT = (
    "\n\n[自动模式提示] 上面这次 Office 写入被拦下了：目标在【工作区外】。自动模式下 Office 只能"
    "写工作区内的文件——读不受限制（工作区外的文件可以打开，会以只读方式打开）。"
    "\n把输出路径改到工作区内（相对路径，或工作区内的绝对路径）后重试。"
)


def failure_hint(text: str) -> str | None:
    """给这条失败输出配【一条】提示；配不上就 None（宁可不说，也不猜）。

    互斥且有序：一条报错只贴一条。顺序即优先级，前面的原因更具体、更该先说：
      缺系统级特权 > 没装 Office > 代理没生效 > Office 越界写 > OS 层越界写。
    Office 自己报的业务错（找不到文件、参数不对）不在表里，一条都不贴——它的原话已经说清了。
    """
    low = text.lower()
    for markers, hint in (
        (_PRIVILEGE_DENIAL_MARKERS, _PRIVILEGE_HINT),
        (_NOT_INSTALLED_MARKERS, _NOT_INSTALLED_HINT),
        (_NO_BROKER_MARKERS, _NO_BROKER_HINT),
        (_OFFICE_WRITE_MARKERS, _OFFICE_WRITE_HINT),
        (_BOUNDARY_DENIAL_MARKERS, _BOUNDARY_HINT),
    ):
        if any(m in low for m in markers):
            return hint
    return None


def _looks_like_boundary_denial(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in _BOUNDARY_DENIAL_MARKERS)


def _looks_like_privilege_denial(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in _PRIVILEGE_DENIAL_MARKERS)


async def _low_integrity_shell(
    command: str,
    ctx: ProviderContext,
    layout: LowIntegrityLayout,
) -> AsyncIterator[CapabilityEvent]:
    """内核 shell() 的 Low 版：逻辑逐段对齐内核，只换启动器 + 叠 redirect_env。"""
    if not command.strip():
        yield CapabilityEvent(kind="error", payload={"code": "EMPTY_COMMAND", "message": "command is required"})
        return

    _blacklist = ctx.extra.get("bash_blacklist") if ctx else None
    err = check_command_safety(command, _blacklist) if _blacklist is not None else check_command_safety(command)
    if err:
        # 全自动无人复核，命中致命黑名单（format/dd/shutdown…）被拦是关键安全事件 → 记一条。
        logger.warning("low-shell 命中黑名单拦截: %s | 命令(repr): %r", err, command)
        yield CapabilityEvent(kind="error", payload={"code": "COMMAND_BLACKLISTED", "message": err})
        return

    yield CapabilityEvent(kind="progress", payload={"status": "starting", "command": command, "low_integrity": "low"})

    ws = str(layout.workspace)
    cwd = ws
    idle = ctx.extra.get("bash_idle_timeout_sec") or _BASH_IDLE_TIMEOUT_SEC_DEFAULT
    hard = ctx.extra.get("bash_hard_cap_sec") or _BASH_HARD_CAP_SEC_DEFAULT
    max_out = ctx.extra.get("bash_max_output_bytes") or _BASH_MAX_OUTPUT_BYTES_DEFAULT

    logger.info("low-shell command (repr): %r", command)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    _extra_env = ctx.extra.get("extra_env") if ctx else None
    if isinstance(_extra_env, dict) and _extra_env:
        env.update(_extra_env)

    # 先做 venv 引导（.venv 落在工作区——已标 Low，可写），再叠 redirect_env，
    # 顺序要紧：venv_env 会改 PATH/VIRTUAL_ENV，redirect_env 只改临时/家目录，两者不打架。
    auto_venv = ctx.extra.get("bash_auto_venv", True) if ctx else True
    venv_dir = ctx.extra.get("bash_venv_dir") or ".venv"
    venv_python = ctx.extra.get("bash_venv_python") if ctx else None
    if auto_venv and command_is_python(command):
        venv_path, _, python_exe = venv_layout(layout.workspace, venv_dir)
        if not python_exe.exists():
            yield CapabilityEvent(kind="progress", payload={"status": "creating_venv", "path": str(venv_path)})
        try:
            await ensure_venv(str(layout.workspace), venv_dir, creator_python=venv_python)
        except VenvError as e:
            yield CapabilityEvent(kind="error", payload={"code": "VENV_ERROR", "message": str(e)})
            return
        # .venv 由 Medium 的 host 进程建，虽在已标 Low 的工作区内（新文件应继承 Low），但继承链
        # 是否覆盖到 site-packages 深层未在 spike 专验；显式再标一次 Low 兜底，确保 Low 子进程
        # 里的 pip 能写 site-packages（否则 pip install 会 access denied）。best-effort。
        try:
            await asyncio.to_thread(windows.label_low, str(venv_path))
            # 标完 .venv 里的 python.exe 也成了 Low 标签文件 → 它在【别的模式/别的终端】里被启动时
            # 也会降级成 Low 进程。还原成 Medium；本会话仍靠 Low 令牌保持边界。
            await asyncio.to_thread(windows.restore_executables_medium, str(venv_path))
        except Exception:
            logger.debug("label_low(.venv) 失败（继承或已是 Low 时无碍）", exc_info=True)
        env = venv_env(env, venv_path)

    # Office broker：自动模式下 Office COM 必须由边界外的 Medium 进程代持（DCOM 会让 Low 客户端
    # 起出来的 Excel 跟着降级、连临时文件都写不了）。这里把管道名和客户端桩目录注入进去，agent
    # 侧 `import ipmc_office` 即可用。没装 Office / 起不来时返回空 dict，照常执行。
    try:
        office_env = await asyncio.to_thread(
            office_manager.ensure_broker, ctx.session_id, ws, layout.temp,
            tuple(str(d) for d in (layout.shared_env,) if d is not None),
        )
    except Exception:
        logger.warning("session %s 起 Office broker 异常，本次不提供 Office 自动化",
                       getattr(ctx, "session_id", "?"), exc_info=True)
        office_env = {}
    for k, v in office_env.items():
        if k == "PYTHONPATH" and env.get("PYTHONPATH"):
            env[k] = v + os.pathsep + env["PYTHONPATH"]
        else:
            env[k] = v

    # 关键：把临时 / 家目录 / AppData 全指到Low 目录（可写集内），收 pip/npm/… 写盘长尾。
    # 每次执行都确保该目录在：它只在会话首次激活时建过一次，中途被清理/删掉的话，TEMP 会指向一个
    # 不存在的路径 → 子进程退回系统 %TEMP%（Medium，写不了）→ "No usable temporary directory"。
    try:
        layout.temp.mkdir(parents=True, exist_ok=True)
    except Exception:
        logger.warning("Low 临时目录建不出来，子进程可能没有可写临时目录：%s", layout.temp, exc_info=True)
    env = redirect_env(env, str(layout.temp))

    queue: asyncio.Queue = asyncio.Queue()

    def _on_output(_stream: str, text: str) -> None:
        queue.put_nowait(("out", text))

    async def _run() -> None:
        try:
            result = await run_low_with_liveness(
                command, cwd=cwd, env=env,
                idle_timeout_sec=idle, hard_cap_sec=hard, output_limit_bytes=max_out,
                on_output=_on_output,
            )
            queue.put_nowait(("done", result))
        except Exception as e:  # noqa: BLE001 — 作为 error 事件回吐
            # 在【活跃异常】处记全 traceback（下方队列消费处已无异常上下文，logger.exception 会打空）。
            logger.exception("low-shell 执行异常：%s", command)
            queue.put_nowait(("exc", e))

    runner = asyncio.create_task(_run())
    try:
        while True:
            kind, payload = await queue.get()
            if kind == "out":
                yield CapabilityEvent(kind="stdout", payload={"data": payload})
            elif kind == "exc":
                # payload 是异常对象；打出类型+消息（完整 traceback 已在 _run 的 except 里记过）。
                logger.error("low-shell failed: %s | %s: %s", command, type(payload).__name__, payload)
                yield CapabilityEvent(kind="error", payload={"code": "EXEC_ERROR", "message": str(payload)})
                return
            elif kind == "done":
                result = payload
                if result.timed_out:
                    survivor = "" if result.terminated_clean else (
                        f" WARNING: {len(result.survivors)} process(es) may still be running."
                    )
                    yield CapabilityEvent(kind="error", payload={
                        "code": "TIMEOUT",
                        "message": f"Command timed out ({result.timeout_kind}).{survivor}",
                    })
                    return
                exit_code = result.exit_code or 0
                content = result.stdout + result.stderr
                # Low 命令失败 → 据报错给模型【一条】引导（failure_hint 内部定优先级、且互斥）。
                # 分条的理由见上面那几段：糊成一段会让模型按错误的原因去折腾。
                if exit_code != 0:
                    hint = failure_hint(content)
                    if hint is _PRIVILEGE_HINT:
                        # 安全节点：缺特权失败≈动态构造的关机/系统级操作被 OS 层挡下（字符串扫没抓到、
                        # 令牌删特权兜住）。WARNING 记一笔——反复出现能直接看出 agent 在硬试关机。
                        logger.warning("session %s Low 命令缺系统级特权失败（疑似关机/改系统特权，已 OS 层阻断并提示模型）：%r",
                                       getattr(ctx, "session_id", "?"), command)
                    elif hint is _NOT_INSTALLED_HINT or hint is _NO_BROKER_HINT:
                        logger.info("session %s Low 命令 Office 自动化受阻（%s），已提示模型：%r",
                                    getattr(ctx, "session_id", "?"),
                                    "本机没装" if hint is _NOT_INSTALLED_HINT else "代理没生效", command)
                    elif hint is not None:
                        # 越界写被拦是自动模式的预期行为，DEBUG 即可（帮定位"写不进"，默认级别不刷屏）。
                        logger.debug("session %s Low 命令疑似越界写被拦，已提示模型改写工作区内：%r",
                                     getattr(ctx, "session_id", "?"), command)
                    if hint:
                        content += hint
                yield CapabilityEvent(kind="result", payload={
                    "content": content,
                    "metadata": {"exit_code": exit_code, "is_error": exit_code != 0},
                })
                return
    finally:
        if not runner.done():
            runner.cancel()


# 系统级致命动作：即便被 powershell -Command "…" / python -c "…" 包裹，也要拦。内核的黑名单是
# 【逐段取命令词】匹配，包裹命令的命令词是 powershell/python，看不到里面的 Restart-Computer/shutdown
# → 全被绕过（实测 agent 用 Restart-Computer 真把电脑重启了）。故这里对【整条命令串】按词边界扫。
# 只收「作为子串出现也几乎不误伤」的具体动词/cmdlet/API 名/命令；裸 dd（到处是 add/middle）不收，
# 仍交给内核逐段命令词黑名单(FATAL_ONLY_BLACKLIST)。任何模式都拦(自动模式也不例外)。
# 诚实局限：字符串扫抓不到【动态构造/编码】的调用(base64 -EncodedCommand、字符拼接、iex)——那类
# 靠自动模式下 Job 的 EXITWINDOWS(禁关机)在 OS 层兜底(见 windows.make_job)。
_FATAL_WRAPPED = re.compile(
    r"(?i)("
    r"\b(shutdown|reboot|poweroff|logoff|halt)\b"                                    # 关机/重启/注销命令
    r"|\b(restart-computer|stop-computer)\b"                                         # PowerShell cmdlet
    r"|\b(win32shutdown|exitwindowsex|initiatesystemshutdown|ntshutdownsystem)\b"    # WMI/CIM/Win32 API
    r"|\bpsshutdown\b"                                                               # Sysinternals
    r"|\bformat\s+[a-z]:"                                                            # format D:（带盘符，避开 .format()）
    r"|\b(format-volume|format-disk|clear-disk|initialize-disk|remove-partition)\b"  # PowerShell 存储销毁
    r"|\bdiskpart\b"                                                                 # 磁盘分区(clean/delete)
    r"|\bbcdedit\b"                                                                  # 引导配置(删引导→开不了机)
    r"|\bcipher\b\s+/w"                                                              # 擦除空闲空间
    r")"
)


async def _fatal_blocked(command: str, hit: str) -> AsyncIterator[CapabilityEvent]:
    logger.warning("致命命令被拦截（整串扫，含包裹）：命中=%s cmd=%s", hit, command)
    # 给模型的回复：明确拒绝 + 覆盖真实类别（不止关机）+ 把它引回正事；【不】透露拦截机制，
    # 免得对抗性模型据此换绕法。
    yield CapabilityEvent(kind="error", payload={
        "code": "FATAL_BLOCKED",
        "message": (
            f"命令被拒绝：命中系统级致命/破坏性操作「{hit}」（关机 / 重启 / 磁盘分区 / 引导配置这类）。"
            f"出于安全，任何模式下都不允许执行——请不要再尝试关闭或重启本机、改动磁盘或引导，"
            f"回到用户交代的实际任务上。"
        ),
    })


def make_shell_invoker(
    kernel_invoker: Callable,
    resolve_layout: Callable[[str], LowIntegrityLayout | None],
) -> Callable:
    """包一层 shell invoker：先拦【被包裹的致命命令】(全模式)，再按低完整性会话走 Low / 内核路径。

    kernel_invoker  —— 父类 _build_invokers()["shell"]，签名 (args, ctx) -> AsyncIterator。
    resolve_layout  —— session_id → LowIntegrityLayout（非低完整性返回 None）；由 provider 子类提供。
    """
    def invoker(arguments: dict, ctx: ProviderContext) -> AsyncIterator[CapabilityEvent]:
        command = arguments.get("command", "") or ""
        m = _FATAL_WRAPPED.search(command)
        if m:
            # 整串命中重启/关机 → 直接拒，绝不执行（低完整性只挡文件写，挡不住系统重启，故必须在这拦）。
            return _fatal_blocked(command, m.group(1))
        layout = resolve_layout(ctx.session_id) if ctx else None
        if layout is None or not windows.available():
            # 非 strict-auto 会话，或非 Windows/无 pywin32 → 内核默认执行，零行为差异。
            return kernel_invoker(arguments, ctx)
        return _low_integrity_shell(command, ctx, layout)
    return invoker
