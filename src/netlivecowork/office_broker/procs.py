"""Office 进程记账：谁是 Office、现在有哪些、某几个进程派生出了哪些 Office 子进程。

单独一个模块是因为 broker 侧（自己收摊）和 host 侧（broker 被强杀后兜底收尸）都要用同一份
映像名表和同一套判定，两边各写一份就必然分叉——分叉的后果是漏掉一类没有界面、一直抱着工作区
文件锁的孤儿进程。
"""

from __future__ import annotations

# 进程外 Office 服务器的映像名。这些进程由 RPCSS 启动，**不是 broker 的子进程**，Job 的
# KILL_ON_JOB_CLOSE 管不到（Job 成员资格只随子进程继承），所以只能自己记账。
# 每加一个 ProgID 白名单项就要在这里补对应的 exe，`test_office_images_cover_every_allowed_progid`
# 会盯着这一点。
OFFICE_IMAGES = (
    "excel.exe", "winword.exe", "powerpnt.exe",
    "outlook.exe", "msaccess.exe", "mspub.exe",
    "visio.exe", "winproj.exe", "onenote.exe",
)


def is_office(name: str | None) -> bool:
    return (name or "").lower() in OFFICE_IMAGES


def office_pids() -> set[int]:
    """当前所有 Office 进程的 PID（拿不到 psutil 就返回空集，记账退化但不报错）。"""
    try:
        import psutil
    except Exception:
        return set()
    out = set()
    for proc in psutil.process_iter(["name"]):
        try:
            if is_office(proc.info.get("name")):
                out.add(proc.pid)
        except Exception:
            continue
    return out


def office_descendants(pids) -> set[int]:
    """pids 派生出来的 Office 子孙进程。

    实测 Publisher：自动化拉起的 MSPUB.EXE 会再拉一个 MSPUB.EXE 子进程，只杀记账里那个，
    子进程就留下来了。这一层必须在杀父进程【之前】取，父进程一没，父子关系也就查不到了。
    """
    try:
        import psutil
    except Exception:
        return set()
    out = set()
    for pid in pids:
        try:
            for child in psutil.Process(pid).children(recursive=True):
                if is_office(child.name()):
                    out.add(child.pid)
        except Exception:
            continue
    return out
