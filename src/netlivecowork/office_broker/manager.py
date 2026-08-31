"""host 侧的 broker 生命周期：按会话拉起 Medium 子进程、给 Low 会话注入连接信息、结束时收摊。

broker 是**每会话一个**：闸门的工作区是会话专属的，共用一个进程就得在每次调用里带会话身份，
反而更容易出错。空转的 broker 只是个等在管道上的 python 进程，Office 要等 agent 真去
Dispatch 才起。

仅 Windows + pywin32；其余平台/无 Office 时整体 no-op（`env_for` 返回空 dict，agent 那侧
import ipmc_office 会拿到一句"当前会话没有 broker"的明确报错）。
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from netlivecowork.low_integrity import windows
from netlivecowork.office_broker import pipe as pipe_mod
from netlivecowork.office_broker import procs
from netlivecowork.office_broker.client_stub import write_stub

logger = logging.getLogger(__name__)

_ENV_PIPE = "NLC_OFFICE_PIPE"


@dataclass
class _Broker:
    proc: subprocess.Popen
    pipe_name: str
    client_dir: str
    workspace: str
    pid_file: str


_brokers: dict[str, _Broker] = {}

# 所有 broker 共用的 kill-on-close Job：句柄随本进程消失而关闭，job 里的 broker 就一并被杀。
# 这是唯一一条在 host **被强杀/崩溃** 时也成立的清理路径——Windows 的子进程不会因为父进程没了
# 就退出，而冻结态的 broker 跑的是 app 自己的 exe，留一个就够让下次安装报「无法停止
# IPMaster-Cowork」（它锁着安装目录里的 exe）。
_job = None
_job_tried = False


def _ensure_job():
    global _job, _job_tried
    if not _job_tried:
        _job_tried = True
        _job = windows.make_kill_on_close_job()
    return _job


def office_available() -> bool:
    """本机是否装了 Office（没装就别白起 broker）。查注册表 ProgID，不实际启动 Office。"""
    if os.name != "nt":
        return False
    try:
        import winreg
        for progid in ("Excel.Application", "Word.Application", "PowerPoint.Application",
                       "Outlook.Application", "Access.Application", "Visio.Application",
                       "Publisher.Application", "MSProject.Application", "OneNote.Application"):
            try:
                winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, progid))
                return True
            except OSError:
                continue
    except Exception:
        logger.debug("查 Office ProgID 失败", exc_info=True)
    return False


def _broker_argv(pipe_name: str, workspace: str, allowed_roots: tuple[str, ...],
                 pid_file: str) -> list[str]:
    """怎么把 broker 起起来。

    冻结态（PyInstaller）下 sys.executable 是 app 自己的 exe，不能 `-m`；此时用共享 venv 的
    python 跑源码不现实（那边没装 netlivecowork）。故冻结态走 app exe 的子命令入口
    `--office-broker`（见 cli.py）；dev 态直接 `python -m ...`。
    """
    base = ([sys.executable, "--office-broker"] if getattr(sys, "frozen", False)
            else [sys.executable, "-m", "netlivecowork.office_broker.server"])
    argv = base + ["--pipe", pipe_name, "--workspace", workspace, "--pid-file", pid_file,
                   "--parent-pid", str(os.getpid())]
    for r in allowed_roots:
        argv += ["--allow", r]
    return argv


def ensure_broker(session_id: str, workspace: str, low_temp: Path,
                  allowed_roots: tuple[str, ...] = ()) -> dict[str, str]:
    """确保该会话有一个活着的 broker，返回要注入给 Low 子进程的环境变量。

    返回的 env 片段：`NLC_OFFICE_PIPE`（管道名）+ `PYTHONPATH` 追加桩目录。拿不到就返回 {}，
    调用方原样继续（Office 不可用不该拖垮 shell 执行）。
    """
    if not windows.available() or not office_available():
        return {}
    b = _brokers.get(session_id)
    if b is not None and b.proc.poll() is None and b.workspace == workspace:
        return {_ENV_PIPE: b.pipe_name, "PYTHONPATH": b.client_dir}
    stop_broker(session_id)   # 工作区变了或进程死了 → 重开

    pipe_name = pipe_mod.random_pipe_name(session_id)
    try:
        client_dir = write_stub(low_temp / "ipmc_client")
        # 输出落文件而不是 DEVNULL：broker 起不来时这是唯一的现场（它没有控制台）。
        log_path = Path(low_temp) / "office_broker.log"
        pid_file = str(Path(low_temp) / "office_pids.txt")
        log_fh = open(log_path, "ab", buffering=0)   # noqa: SIM115 — 随子进程生命周期
        proc = subprocess.Popen(
            _broker_argv(pipe_name, workspace, allowed_roots, pid_file),
            stdout=log_fh, stderr=log_fh,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        logger.warning("session %s 起 Office broker 失败（Office 自动化本次不可用）", session_id, exc_info=True)
        return {}

    # Job 要在等管道之前挂上：万一 host 正好在这几秒里被杀，broker 也已经在 job 里了。
    windows.assign_pid_to_job(_ensure_job(), proc.pid)

    # 等管道真的建出来再把环境变量交出去：否则 agent 可能抢在 broker 建管道之前去连。
    if not pipe_mod.wait_until_exists(pipe_name):
        logger.warning("session %s Office broker 起了但管道没出现，详见 %s", session_id, log_path)
        try:
            proc.terminate()
        except Exception:
            logger.debug("终止无响应 broker 失败", exc_info=True)
        return {}
    _brokers[session_id] = _Broker(proc=proc, pipe_name=pipe_name, client_dir=client_dir,
                                   workspace=workspace, pid_file=pid_file)
    logger.info("session %s Office broker 已启动 pid=%s pipe=%s", session_id, proc.pid, pipe_name)
    return {_ENV_PIPE: pipe_name, "PYTHONPATH": client_dir}


def _reap_orphan_office(pid_file: str) -> int:
    """按 broker 落盘的 pid 文件收尸，返回杀掉的进程数。

    为什么需要这一层：Office 由 RPCSS 启动，**不是 broker 的子进程**，Job 的 KILL_ON_JOB_CLOSE
    管不到（Job 成员资格只随子进程继承）。broker 正常退出时会自己 Quit，但被强杀（terminate/
    崩溃/掉电重启后残留）时来不及，那些 EXCEL.EXE 就成了没有界面的孤儿，一直锁着工作区里的文件。
    只杀 pid 文件里记的、且映像名确实是 Office 的进程——PID 会复用，名字这层校验不能省；用户
    自己开的 Office 从来不会进这个文件（见 server.op_dispatch 的快照记账）。
    """
    try:
        pids = [int(x) for x in Path(pid_file).read_text(encoding="utf-8").split() if x.strip()]
    except Exception:
        return 0
    killed = 0
    try:
        import psutil
    except Exception:
        return 0
    # broker 被强杀时它来不及把子孙进程写进账本（实测 Publisher 会再拉一个 MSPUB.EXE），
    # 这里现查一次；父进程还活着，父子关系才查得到，所以要在开杀之前取。
    pids = list(dict.fromkeys(pids)) + sorted(procs.office_descendants(pids))
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            if procs.is_office(proc.name()):
                proc.kill()
                killed += 1
        except Exception:
            continue
    try:
        Path(pid_file).unlink()
    except Exception:
        pass
    return killed


def stop_broker(session_id: str) -> None:
    """结束会话/切走自动模式时收摊。

    先给 broker 一点时间自己退（它会 Quit 掉自己拉起的 Office），超时才强杀；无论哪条路径，
    最后都按 pid 文件把残留的 Office 进程收干净。
    """
    b = _brokers.pop(session_id, None)
    if b is None:
        return
    try:
        if b.proc.poll() is None:
            b.proc.terminate()
            try:
                b.proc.wait(timeout=15)   # 留够 Quit + 强杀兜底的时间（见 server.shutdown）
            except subprocess.TimeoutExpired:
                b.proc.kill()
    except Exception:
        logger.debug("停 Office broker 失败", exc_info=True)
    killed = _reap_orphan_office(b.pid_file)
    logger.info("session %s Office broker 已停止%s", session_id,
                f"，另收掉 {killed} 个残留 Office 进程" if killed else "")


def stop_all() -> None:
    """停掉所有会话的 broker。app 关闭时必须走一遍。

    不走这一遍的后果不是"多个空转进程"那么轻：冻结态下 broker 就是 app 自己的 exe，它活着就
    锁着安装目录，装新版会报「无法停止 IPMaster-Cowork」；它抱着的 Office 进程也一起留着。
    """
    for session_id in list(_brokers):
        try:
            stop_broker(session_id)
        except Exception:
            logger.debug("停 session %s 的 broker 失败", session_id, exc_info=True)


_BROKER_ARGV_MARKS = ("--office-broker", "netlivecowork.office_broker.server")


def reap_orphan_brokers() -> int:
    """启动时清掉【上一次运行遗留的】孤儿 broker，返回杀掉的个数。

    有了 Job + 看门狗之后正常不该有遗留，但装了旧版本的机器上已经躺着了，而那些进程正是让安装
    程序报「无法停止 IPMaster-Cowork」的东西——总得有一条能自愈的路径。

    只杀**父进程已经不在**的：还有父进程的说明另一个 host 正在用它，杀了会把人家正跑着的会话
    弄坏。父进程死后 ppid 要么指向不存在的号，要么被复用成一个比子进程还年轻的进程，两种都算孤儿。
    """
    try:
        import psutil
    except Exception:
        return 0
    killed = 0
    me = os.getpid()
    for proc in psutil.process_iter(["pid", "ppid", "cmdline", "create_time"]):
        try:
            if proc.info["pid"] == me:
                continue
            cmdline = " ".join(proc.info.get("cmdline") or ())
            if not any(m in cmdline for m in _BROKER_ARGV_MARKS):
                continue
            ppid = proc.info.get("ppid") or 0
            try:
                parent_born = psutil.Process(ppid).create_time()
            except Exception:
                parent_born = None
            if parent_born is not None and parent_born <= (proc.info.get("create_time") or 0):
                continue    # 父进程还活着，是别人正在用的 broker
            proc.kill()
            killed += 1
            logger.info("清掉上次遗留的孤儿 Office broker pid=%s", proc.info["pid"])
        except Exception:
            continue
    return killed


def env_for(session_id: str) -> dict[str, str]:
    """已在跑的 broker 的连接环境（不负责拉起）。"""
    b = _brokers.get(session_id)
    if b is None or b.proc.poll() is not None:
        return {}
    return {_ENV_PIPE: b.pipe_name, "PYTHONPATH": b.client_dir}
