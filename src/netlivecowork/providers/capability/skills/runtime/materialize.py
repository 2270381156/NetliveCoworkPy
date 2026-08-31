"""临时物化（materialize）云端 skill：下载的 zip → 解压到系统临时区随机目录 → 用完即删。

用于「引用式加载」：引用只存元数据，真正读内容/执行脚本时才把 zip 下载解压到这里，
读/执行完立即删除（决策：激进删除、不长存）。

目录约定（隐蔽、前缀不含 "skill"）：
    <系统临时区>/imc-rt/<sessionId>/<random>/
  - sessionId 分组，便于会话结束整片清扫；<random> 由 mkdtemp 生成，隔离并发。
  - 引用时（提取元数据）用 sessionId="install"。

清理：
  - 每次操作：materialized() 上下文退出即删该次目录；
  - 会话结束：sweep_session(session_id)；
  - 进程启动：sweep_all()（清崩溃残留）。
"""

from __future__ import annotations

import contextlib
import logging
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

from netlivecowork.low_integrity import windows

from .zip_utils import extract_zip

logger = logging.getLogger(__name__)

_ROOT_NAME = "imc-rt"   # 前缀不含 "skill"


def temp_root() -> Path:
    return Path(tempfile.gettempdir()) / _ROOT_NAME


def prepare_low_root() -> None:
    """把云端 skill 物化根 `imc-rt` 标成 Low（`(OI)(CI)` 继承）——其下所有物化子目录/文件自动继承 Low。

    这样**不用每次物化都对解压出的 skill 文件跑 icacls /T**：标一次父目录，子内容继承即可，让
    自动模式下以 Low 运行的 skill 脚本能写自己的 SKILL_DIR。

    在 `sweep_all()` 之后调用（sweep_all 删掉了 imc-rt，这里重建空目录并标——空目录，秒级）。imc-rt
    根在运行期不会被删（只删 session 子目录），故这次标记保持到进程结束；下次启动 sweep_all 再重建、
    再由本函数重标（所以是每次启动标一次空根，不是持久标记）。仅 Windows+pywin32 生效；best-effort。
    """
    if not windows.available():
        return
    root = temp_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        windows.label_low(str(root))
        logger.info("云端 skill 物化根已标 Low（子目录继承）：%s", root)
    except Exception:
        logger.warning("标云端 skill 物化根 Low 失败：%s", root, exc_info=True)


@contextlib.contextmanager
def materialized(zip_bytes: bytes, *, session_id: str = "install") -> Iterator[Path]:
    """把 zip 解压到 <tmp>/imc-rt/<session_id>/<random>/，yield 该目录；退出即删。

    extract_zip 会校验 zip 合法、单根扁平化、防路径穿越；非法则抛 SkillError。
    """
    base = temp_root() / (session_id or "install")
    base.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(dir=base))
    try:
        extract_zip(zip_bytes, work)
        # 不在这里标 Low：物化根 imc-rt 已在启动时标了 (OI)(CI) 继承（见 prepare_low_root），
        # base/work/解压出的文件都自动继承 Low，无需每次物化再跑 icacls。
        # 但继承同样会把解压出的 .exe 标成 Low —— 那些 exe 无论被谁启动都会降级成 Low 进程
        # （新进程 IL = min(令牌, 主映像文件)），故还原成 Medium。best-effort。
        try:
            windows.restore_executables_medium(str(work))
        except Exception:
            logger.debug("还原物化 skill 的 exe 标签失败（无 exe 时本就是 no-op）", exc_info=True)
        yield work
    finally:
        shutil.rmtree(work, ignore_errors=True)
        # 顺手删掉已空的会话父目录，别留空壳。仅当目录已空时 rmdir 才成功；并发下
        # 若还有其它 materialize 在用，rmdir 抛 OSError → 忽略（那份用完时再删）。
        with contextlib.suppress(OSError):
            base.rmdir()


def sweep_session(session_id: str) -> None:
    """会话结束：删掉该会话的整片临时目录。"""
    if session_id:
        shutil.rmtree(temp_root() / session_id, ignore_errors=True)


def sweep_all() -> None:
    """进程启动：清空整个 imc-rt 根（残留必是崩溃遗留，无长存价值）。"""
    shutil.rmtree(temp_root(), ignore_errors=True)
