"""已装清单 —— "这台机器上现在装了哪几个"。

只读。装和删在 `install.py`（阶段 2）。

**装了哪几个既决定界面列什么，也决定实际能跑什么**（需求 D1/F1）——
所以这个清单是权限的落点，不只是展示数据。
"""
from __future__ import annotations

import logging
from pathlib import Path

from .manifest import MANIFEST_NAME, MASTER_ID, Cowork
from .manifest_parse import read

logger = logging.getLogger(__name__)


def list_all(coworks_dir: Path) -> list[Cowork]:
    """列出已装的 cowork，按展示次序排序。

    **目录不存在 = 一个都没装，不是错误**：全新安装、或者授权对账还没跑过时就是这样，
    抛错会把一个正常状态变成故障。

    排序键带上 id：次序相同时若不定序，界面上的排列会随文件系统枚举顺序抖动 ——
    用户会觉得"每次打开顺序都不一样"，而这既不报错也无从复现。
    """
    coworks_dir = Path(coworks_dir)
    if not coworks_dir.is_dir():
        return []

    out: list[Cowork] = []
    for d in sorted(coworks_dir.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name == MASTER_ID:
            continue

        manifest = d / MANIFEST_NAME
        if not manifest.is_file():
            # 目录在但没有清单：多半是解包到一半或手工放错，不当成一个 cowork。
            logger.warning("cowork：%s 缺 %s，跳过", d, MANIFEST_NAME)
            continue

        item = read(manifest)
        if item is None:
            continue

        if item.id != d.name:
            # id 与目录名不一致时，按目录名找模板会落空。**宁可跳过也不半信半疑地收下**：
            # 收下的表现是"这个 cowork 在列表里但建不了会话"，比不显示更难查（需求 F2）。
            logger.warning("cowork：%s 的 id=%r 与目录名不一致，跳过", manifest, item.id)
            continue

        out.append(item)

    return sorted(out, key=lambda c: (c.order, c.id))


def versions(coworks_dir: Path) -> dict[str, str]:
    """已装的 id → 版本。给对账算差集用（见 entitlement）。"""
    return {c.id: c.version for c in list_all(coworks_dir)}


def version_of(coworks_dir: Path, cowork_id: str) -> str | None:
    """某一个的已装版本；没装返回 None。"""
    return versions(coworks_dir).get(cowork_id)


def get(coworks_dir: Path, cowork_id: str) -> Cowork | None:
    """按 id 取一个已装的 cowork。"""
    for c in list_all(coworks_dir):
        if c.id == cowork_id:
            return c
    return None


def is_installed(coworks_dir: Path, cowork_id: str) -> bool:
    """这个 cowork 现在可用吗。

    **只读推导，不写状态**：会话是否只读、能不能新建，全部由它推出来
    （需求 I4）。套件装回来，那些判断自己就变回可用，没有状态要迁移。
    """
    return get(coworks_dir, cowork_id) is not None
