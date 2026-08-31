"""什么时候能导入 —— 两个判断，各管一件事（需求 J13/J14）。

    主动提示   "本机第一次装 NetLIVE Cowork"      只弹一次
    入口可用   "新版还没有属于自己的会话"          推导，不写状态

## 为什么拆成两个

严格锁死在首启的话：用户首启手头忙，点了"以后再说"，**就再也导不了了** ——
这会直接变成支持工单。

## 为什么"可用"的判据是"没有自己的会话"

会话正是会与导入数据冲突的东西。还没建过会话时导入是安全的；
一旦建了，入口自动灰掉并说明原因。与只读会话同一个套路：
**可用性是推导的，不写状态**。

## 这条限定同时消掉了"合并还是覆盖"（需求 J15）

新版必然是空的 ⇒ 不存在冲突 ⇒ 不需要回答"已经用过一阵怎么办"。
**这是一条用约束换掉一整块复杂度的取舍，实现时不要为了"更灵活"把它放开** ——
放开就要重新面对合并语义，而那是一整套没人测得全的分支。
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

#: 首启时应用自己写下的安装版本标记。它是"这台机器装过一次了"的凭据。
INSTALLED_MARKER = "installed-version"

#: 导入完成后留下的标记，避免重复导入（需求 J9）。
IMPORTED_MARKER = ".imported-from-legacy"


def is_first_run(app_data_dir: Path) -> bool:
    """这是本机第一次装吗。

    ⚠ **顺序是这条的全部难点**（需求 J13）：那个标记在首启播种的末尾就会被写出去，
    判定晚一步就**永远判成"不是第一次"**，而且不报错 —— 用户再也看不到导入引导。

    同一个文件里已经因为同样的理由踩过两次（升级判定、配置规整）。

    ⚠ **不能用浏览器侧那个目录判**：它在应用就绪之前就被创建了，永远"存在"。
    这里判的是业务数据目录里的标记。

    ⚠ **卸载重装不算第一次**：卸载默认不删数据目录，标记还在。
    这是对的 —— 数据还在，本来就不需要导入。
    """
    return not (Path(app_data_dir) / INSTALLED_MARKER).exists()


def already_imported(app_data_dir: Path) -> bool:
    return (Path(app_data_dir) / IMPORTED_MARKER).exists()


def mark_imported(app_data_dir: Path) -> None:
    from datetime import datetime, timezone

    p = Path(app_data_dir) / IMPORTED_MARKER
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")


def can_import(app_data_dir: Path, *, own_session_count: int) -> bool:
    """现在还能不能导入。

    ```
    可导入 ≡ 新版的会话库里一条会话都没有（且没导过）
    ```

    `own_session_count` 由调用方查会话库给出 —— 本模块不碰数据库
    （它是一次性工具，不该依赖运行期的那套）。
    """
    if already_imported(app_data_dir):
        return False
    return own_session_count <= 0


def should_prompt(app_data_dir: Path, legacy_dir: Path, *, own_session_count: int) -> bool:
    """要不要**主动弹**导入引导。

    只在"第一次装 + 旧数据在 + 还能导"三者同时成立时弹一次。
    """
    return (
        is_first_run(app_data_dir)
        and Path(legacy_dir).is_dir()
        and can_import(app_data_dir, own_session_count=own_session_count)
    )
