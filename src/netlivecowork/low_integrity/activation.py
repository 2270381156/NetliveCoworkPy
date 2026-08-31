"""strict-auto 会话的 低完整性边界激活/停用（host 接线用）。

在会话切到 strict-auto（且 Windows + pywin32 可用）时调用 activate：建共享/临时目录、把
{工作区 + 共享环境 + Low 临时目录} 递归标 Low、登记到 fs provider——此后该会话的 shell 走
Low 令牌执行（写受限）。切走或非 Windows 时 deactivate / 直接降级（strict-auto 的准入拒绝
桶依然生效，只是少了 OS 兜底那层）。

标 Low 用 icacls /T，工作区大时可能慢：切模式时【同步只浅标工作区根】(毫秒级，边界立即生效)，
【已有旧文件的递归 /T 转后台】(不卡切换响应，见 activate_low_integrity / _schedule_recursive_label)。
都放线程池；失败不阻断会话（记日志、按未激活处理）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from ctx_weft.providers.capability_filesystem import FilesystemToolsProvider

from netlivecowork.providers.capability.fs_bash_compat import (
    BashExecAliasFilesystemProvider,
)
from netlivecowork.low_integrity import windows
from netlivecowork.low_integrity.env import LowIntegrityLayout

logger = logging.getLogger(__name__)


def _find_provider(runtime) -> BashExecAliasFilesystemProvider | None:
    """从 runtime 找到 app 的 fs provider 子类（唯一能登记低完整性的那个）。"""
    for p in runtime.providers.get_capability_providers():
        if isinstance(p, BashExecAliasFilesystemProvider):
            return p
    # 兜底：万一装的是裸内核 provider（不该发生），返回 None → 降级不激活。
    for p in runtime.providers.get_capability_providers():
        if isinstance(p, FilesystemToolsProvider):
            logger.warning("fs provider 非 app 子类，无法激活 低完整性边界，降级")
            return None
    return None


def _low_temp(data_dir: Path) -> Path:
    """所有 strict-auto 会话共用的 Low 临时目录（TEMP/家目录重定向的落点）。"""
    return data_dir / "low_integrity" / "low_temp"


def _shared_venv_root() -> Path | None:
    """全应用共享 venv 的根目录（打包态共享 venv 模式）；dev 态无共享 venv → None。

    `fs_shared_venv_python` 指向 `<venv>/Scripts/python.exe`（Win）或 `<venv>/bin/python`（POSIX），
    两平台下 venv 根都是 `python.parent.parent`。pip 装包写这个 venv 的 site-packages，故它必须在
    可写集里、标 Low（design §1「共享环境照常可写」）。
    """
    from netlivecowork.config import get_settings
    p = get_settings().fs_shared_venv_python
    if not p:
        return None
    root = Path(p).parent.parent
    return root if root.exists() else None


def label_global_writable_dirs(data_dir: Path) -> None:
    """把【跨会话共享】的可写目录（共享 venv + 全局 low_temp）标 Low——**每个路径只标一次**。

    为什么加"标一次"标记：`icacls /T` 递归标大 venv 可能要几秒；标过一次后目录已带 `(OI)(CI)` 继承
    ACE，之后新装的包会**自动继承 Low**、无需重标，所以标一次就永久有效。标记记在
    `<data>/low_integrity/.low_labeled.json`（存已标过的路径集合）——venv 路径变了（如升级换了目录）
    会被当新路径重新标，老路径留着无害。

    ⚠️ **只在真正进 strict-auto 时调用，不要放到启动路径上**：标 Low 会连带把共享 venv 里的
    `Scripts\\python.exe` 等 .exe 标成 Low，而 Windows 的新进程 IL = min(令牌, 主映像文件)，从没开过
    自动模式的用户也会因此让所有 python/pip 降级成 Low 运行（`restore_executables_medium` 的注释里
    有完整因果）。这里虽已随手还原 .exe，但"用不到就别标"仍是更小的爆炸半径。

    仅 Windows+pywin32 生效；best-effort，标失败不记入标记（下次重试），不阻断。
    """
    if not windows.available():
        return
    label_low_once(_low_temp(data_dir), data_dir)
    shared = _shared_venv_root()
    if shared is not None:
        label_low_once(shared, data_dir)


def sweep_shared_venv_executables(data_dir: Path) -> None:
    """启动时把共享 venv 里的 .exe 还原成 Medium（仅当该 venv 曾被标过 Low）。

    两个必须每次启动都跑的理由：
      ① pip 装包会往 `Scripts\\` 里新建 console script 的 .exe，它们**继承目录的 Low 标签** →
         下次运行又是 Low 进程；
      ② 存量安装的 venv 早已被标过 Low（老版本在启动时无条件标），要靠这一趟把 python.exe 修回来。
    只扫 `Scripts`（不递归 site-packages，那里几乎没有 .exe），一次 icacls 通配符，毫秒级。
    """
    if not windows.available():
        return
    shared = _shared_venv_root()
    if shared is None:
        return
    if str(shared) not in _read_labeled_marker(data_dir / "low_integrity" / ".low_labeled.json"):
        return   # 从没标过 → 里面的 exe 本就是 Medium，不用动
    scripts = shared / ("Scripts" if os.name == "nt" else "bin")
    if not scripts.exists():
        return
    try:
        windows.restore_executables_medium(str(scripts), recursive=False)
    except Exception:
        logger.warning("还原共享 venv 的 exe 标签失败（不阻断启动）：%s", scripts, exc_info=True)


def label_low_once(path: Path, data_dir: Path) -> None:
    """把 path 标 Low，但**每个路径全局只标一次**（标记存 `<data>/low_integrity/.low_labeled.json`）。

    用于 app 管理的**稳定路径**（共享 venv / low_temp / 本地 skill 目录）——这些启动时要标，
    但 `icacls /T` 递归标大目录很慢，每次启动都跑会给所有 Windows 用户（含只用半自动的）加启动
    延迟。标过一次后目录带 `(OI)(CI)` 继承 ACE，新内容自动继承 Low，无需重标 → 标一次即永久有效。

    ⚠️ **只用于 app 管理、不会被用户删掉重建的路径**。会话工作区**不适用**（用户可能删了同名重建，
    标记会误判已标而跳过 → 新目录没标）——工作区仍每次激活时重标（见 activate_low_integrity）。

    仅 Windows+pywin32 生效；标失败不记入标记（下次重试），不阻断。
    """
    if not windows.available():
        return
    marker = data_dir / "low_integrity" / ".low_labeled.json"
    labeled = _read_labeled_marker(marker)
    if str(path) in labeled:
        return   # 标过一次即跳过（新内容由目录继承 (OI)(CI) 自动变 Low）
    try:
        path.mkdir(parents=True, exist_ok=True)
        windows.label_low(str(path))
        # icacls /T 把目录里的 .exe 也标成了 Low，会让【任何模式】下由它启动的进程降级成 Low
        # （新进程 IL = min(令牌, 主映像文件)）→ 立刻还原成 Medium。不影响 strict-auto 的边界，
        # 那条路径靠 Low 令牌，令牌更低时以令牌为准。见 windows.restore_executables_medium。
        windows.restore_executables_medium(str(path))
    except Exception:
        logger.warning("低完整性边界：标目录失败：%s（下次重试）", path, exc_info=True)
        return
    labeled.add(str(path))
    _write_labeled_marker(marker, labeled)
    logger.info("低完整性边界：目录已标 Low（首次）：%s", path)


def _read_labeled_marker(marker: Path) -> set[str]:
    try:
        if marker.exists():
            return set(json.loads(marker.read_text(encoding="utf-8")).get("labeled", []))
    except Exception:
        logger.debug("读 low_labeled 标记失败，按未标处理", exc_info=True)
    return set()


def _write_labeled_marker(marker: Path, labeled: set[str]) -> None:
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            json.dumps({"labeled": sorted(labeled)}, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        logger.debug("写 low_labeled 标记失败", exc_info=True)


async def activate_low_integrity(runtime, session_id: str, *, data_dir: Path) -> str:
    """把会话切成 低完整性边界。返回状态（见 apply_mode_low_integrity 的取值说明）。

    关键区分：`no_workspace`（工作区还没登记，稍后钩子会再激活，【不是】失败）vs
    `no_permission`（工作区打标要管理员、用户取消/失败——边界建不起来）。切自动模式的接口据此
    对 no_permission 拒绝切换（不让用户进"假自动"），对 no_workspace/unsupported 照常放行。
    """
    if not windows.available():
        # DEBUG：_ensure_workspace_registered 每条 send_message 都会调过来，非 Windows 上若用 INFO 会
        # 每条消息刷一遍。降级本身在切模式时已由 set_bash_review_mode 记过/前端弹过，这里不再重复喧哗。
        logger.debug("session %s strict-auto：非 Windows/无 pywin32，低完整性边界降级（准入拒绝桶仍生效）", session_id)
        return "unsupported"
    prov = _find_provider(runtime)
    if prov is None:
        return "failed"
    workspace = prov.registered_workspace(session_id)
    if not workspace:
        logger.warning("session %s 无已登记工作区，低完整性边界暂不激活", session_id)
        return "no_workspace"

    # 已登记为低完整性、且工作区没变 → 本来就活着（_ensure_workspace_registered 每条 send_message 都会
    # 调过来）。直接返回，别每条消息重跑 icacls / 刷一条「已激活」INFO（那既误导又刷屏）。
    existing = prov._resolve_layout(session_id)
    if existing is not None and str(existing.workspace) == str(workspace):
        logger.debug("session %s 低完整性边界已在生效，跳过重复激活", session_id)
        return "activated"

    # 跨会话共享的可写目录（共享 venv + low_temp）**惰性**标 Low：只有真的要进 strict-auto 才标，
    # 从没开过自动模式的用户完全不碰（见 label_global_writable_dirs 的爆炸半径说明）。内部有"标一次"
    # 标记，重复调用是廉价 no-op。
    await asyncio.to_thread(label_global_writable_dirs, data_dir)

    temp = _low_temp(data_dir)
    shared_env = _shared_venv_root()   # 打包态=真实共享 venv 根；dev=None（每工作区 .venv）
    layout = LowIntegrityLayout(workspace=Path(workspace), shared_env=shared_env, temp=temp)
    marker = data_dir / "low_integrity" / ".low_labeled.json"
    # 之前【提权】标过这个工作区 → 标记持久（标记记在盘上），跳过 icacls：否则每次进自动模式都要再弹 UAC。
    already = str(workspace) in _read_labeled_marker(marker)

    # 分步打标（避免切换卡在大工作区的递归 icacls /T 上，见 _schedule_recursive_label）：
    #   already → 跳过；否则普通权限【浅标根】（毫秒级）；「拒绝访问」→ 返回 denied，交由下面弹 UAC 提权。
    def _prepare() -> str:
        temp.mkdir(parents=True, exist_ok=True)
        if already:
            return "skip"
        try:
            windows.label_low(str(workspace), recursive=False)
            return "labeled"
        except RuntimeError as e:
            return "denied" if windows.is_icacls_access_denied(str(e)) else "error"

    t0 = time.monotonic()
    try:
        outcome = await asyncio.to_thread(_prepare)
    except Exception:
        logger.exception("session %s 建 Low 临时目录失败，低完整性边界降级", session_id)
        return "failed"

    if outcome == "error":
        logger.warning("session %s 标 Low 失败（非权限问题），低完整性边界降级", session_id)
        return "failed"

    if outcome == "denied":
        # 普通权限改不了该工作区的完整性标签（不拥有它）→ 弹一次 UAC，用管理员 /T 全标。
        logger.info("session %s 工作区无权限打标，弹 UAC 提权：%s", session_id, workspace)
        elevated = await asyncio.to_thread(windows.label_low_elevated, str(workspace))
        if elevated != "ok":
            logger.warning(
                "session %s 自动模式无法启用：工作区打标需管理员，%s（边界建不起来 → 拒绝切换）",
                session_id, "用户在 UAC 取消了授权" if elevated == "cancelled" else "提权失败")
            return "no_permission"
        _mark_workspace_labeled(marker, str(workspace))   # 记标记：下次进自动模式不再弹 UAC
        _schedule_executable_restore(session_id, str(workspace))   # 提权 /T 把 exe 也标 Low 了，还原
        prov.register_low_integrity(session_id, layout)
        logger.info("session %s 低完整性边界已激活（提权 /T 打标成功，耗时 %.1fs）：可写集=%s",
                    session_id, time.monotonic() - t0, [str(d) for d in layout.writable_dirs()])
        return "activated"

    # outcome in ("labeled", "skip")：普通权限标成功、或此前已标过。
    prov.register_low_integrity(session_id, layout)   # 边界（Low 令牌，写不出工作区）立即生效
    logger.info("session %s 低完整性边界已激活（%s %.2fs）：可写集=%s", session_id,
                "已标过跳过" if outcome == "skip" else "浅标根", time.monotonic() - t0,
                [str(d) for d in layout.writable_dirs()])
    if outcome == "labeled":
        _schedule_recursive_label(session_id, str(workspace))   # 旧文件递归 /T 转后台（末尾会还原 exe）
    else:
        # skip：此前版本标过、本次没跑 icacls。老版本从没还原过 exe，补一趟（幂等、后台）。
        _schedule_executable_restore(session_id, str(workspace))
    return "activated"


def _mark_workspace_labeled(marker: Path, workspace: str) -> None:
    """把已(提权)标过 Low 的工作区记进标记，下次进自动模式据此跳过 icacls、不再弹 UAC。
    注意：用户删掉再重建同名目录时标记会误判已标（同 label_low_once 的已知取舍，罕见）。"""
    labeled = _read_labeled_marker(marker)
    labeled.add(workspace)
    _write_labeled_marker(marker, labeled)


# 后台递归标记任务的强引用集合：create_task 不持引用会被 GC，用完自动移除。
_bg_label_tasks: set[asyncio.Task] = set()
# 正在后台递归标记的工作区路径：快速来回切模式时，同一工作区已有任务在跑就跳过，避免堆叠 icacls /T。
_bg_labeling_workspaces: set[str] = set()


def _schedule_recursive_label(session_id: str, workspace: str) -> None:
    """把工作区【已有旧文件】的递归 Low 标记丢到后台，不阻塞切模式的响应。

    为什么能后台、且不牺牲安全：strict-auto 的安全边界来自「shell 以 Low 令牌运行」——register_low_integrity
    一登记就生效，Low 进程无论如何写不出工作区。icacls 标记只决定「Low 进程能不能写工作区【里面】的
    文件」：根已同步标好（新建文件继承 Low、可写），这里补标的是【已有旧文件/旧子目录】。故后台期间
    唯一影响是「改工作区里预先存在的旧文件」可能短暂失败（低不能写高），跑完自愈——不是安全缺口。
    切模式时模型多在流式输出，等它真发第一条 shell，后台多半已跑完，窗口几乎碰不到。
    """
    if workspace in _bg_labeling_workspaces:
        # 同一工作区已有后台标记在跑 → 不重复起（icacls /T 幂等，堆叠只是白费 CPU）
        logger.info("session %s 后台递归标 Low 已在进行，跳过：%s", session_id, workspace)
        return
    _bg_labeling_workspaces.add(workspace)

    async def _run() -> None:
        t0 = time.monotonic()
        logger.info("session %s 后台递归标 Low 开始：%s", session_id, workspace)
        try:
            await asyncio.to_thread(windows.label_low, workspace, recursive=True)
            # /T 会把工作区里的 .exe（项目自己的 .venv\Scripts\python.exe、node_modules\.bin\*.exe…）
            # 一并标 Low，那些 exe 之后在【任何模式下、乃至 app 之外】启动都会降级成 Low 进程。
            # 必须在 /T 之后还原，顺序反了会被 /T 重新标回 Low。
            await asyncio.to_thread(windows.restore_executables_medium, workspace)
            logger.info("session %s 后台递归标 Low 完成，耗时 %.1fs：%s",
                        session_id, time.monotonic() - t0, workspace)
        except Exception:
            logger.warning(
                "session %s 后台递归标 Low 失败（耗时 %.1fs），旧文件可能暂改不了（新建文件已继承 Low）：%s",
                session_id, time.monotonic() - t0, workspace, exc_info=True)
        finally:
            _bg_labeling_workspaces.discard(workspace)
    task = asyncio.create_task(_run())
    _bg_label_tasks.add(task)
    task.add_done_callback(_bg_label_tasks.discard)


def _schedule_executable_restore(session_id: str, workspace: str) -> None:
    """只把工作区里的 .exe 还原成 Medium（不重标 Low），后台跑。

    用于两种"这次没跑 /T"的情形：① 提权 /T 刚标完；② 此前版本已标过、本次跳过 icacls。后者是给
    存量用户擦屁股——老版本标完从没还原过 exe，那些工作区里的 python.exe 至今仍是 Low 标签。
    """
    if workspace in _bg_labeling_workspaces:
        return   # 递归标记任务在跑，它自己末尾会还原，别抢
    _bg_labeling_workspaces.add(workspace)

    async def _run() -> None:
        try:
            n = await asyncio.to_thread(windows.restore_executables_medium, workspace)
            if n:
                logger.info("session %s 工作区 .exe 标签已还原为 Medium（%d 个目录）：%s", session_id, n, workspace)
        except Exception:
            logger.warning("session %s 还原工作区 exe 标签失败：%s", session_id, workspace, exc_info=True)
        finally:
            _bg_labeling_workspaces.discard(workspace)
    task = asyncio.create_task(_run())
    _bg_label_tasks.add(task)
    task.add_done_callback(_bg_label_tasks.discard)


def deactivate_low_integrity(runtime, session_id: str) -> None:
    """会话切走 strict-auto / 结束时解除低完整性登记（其后 shell 回落内核默认执行）。"""
    prov = _find_provider(runtime)
    if prov is not None:
        prov.deregister_low_integrity(session_id)
    # Office broker 只为自动模式存在：切走就收摊，别留着个抱着 Excel 的进程。
    # 半自动/人工模式下 agent 直接用 win32com 即可（那时进程是 Medium，Office 本来就能用）。
    from netlivecowork.office_broker import manager as office_manager
    office_manager.stop_broker(session_id)


async def apply_mode_low_integrity(runtime, session_id: str, mode: str, *, data_dir: Path) -> str:
    """按会话的当前模式同步 低完整性边界：strict-auto → 激活，其它 → 停用。返回状态字符串：

      activated     —— strict-auto 且边界已建起（含提权成功）。
      unsupported   —— strict-auto 但非 Windows/无 pywin32（无 OS 边界，按设计仍允许，前端弹降级）。
      no_workspace  —— strict-auto 但工作区还没登记（稍后钩子会再激活，不是失败）。
      no_permission —— strict-auto 但工作区打标要管理员、用户取消/提权失败（边界建不起 → 应拒绝切换）。
      failed        —— strict-auto 其它失败（无 provider 等）。
      deactivated   —— 非 strict-auto，已解除低完整性登记。

    统一入口，三处复用：① 用户切模式（set_bash_review_mode）；② 会话创建登记工作区后；
    ③ resume/重启后重新登记工作区后。后两处是【持久化的关键】——模式从盘恢复了，但 provider
    的低完整性登记表是内存的、重启即丢，必须据恢复的模式重新激活（否则"显示自动模式但无边界"）。
    """
    if mode == "strict-auto":
        return await activate_low_integrity(runtime, session_id, data_dir=data_dir)
    deactivate_low_integrity(runtime, session_id)
    return "deactivated"
