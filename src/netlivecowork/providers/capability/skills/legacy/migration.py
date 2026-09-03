"""**一次性迁移**：已安装的市场 skill → 引用。迁完即可整目录删除。

把旧 SkillPullStore 记录的、解压在 skills_dir 里的市场 skill 转成引用记录，并删掉本地
文件。用户自建的本地 skill（不在 pull store 里）一律不动。幂等：迁完 pull store 清空，
再跑不做事。

旧数据无 owner（旧 pull 未记录引用者）→ 迁移出来的 mythos 引用 owner=None，按"老数据
不过滤"处理（真正取内容时仍用当前用户下载，越权由那家拦）。

**退役条件**见 ``legacy/__init__.py``。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from ctx_weft.providers.capability_skill_local._parser import load_skill_md

from ..adapters.scopes import GENERAL_SCOPE
from ..references.store import ReferenceIdentity, SkillReference, SkillReferenceStore
from .pull_store import SkillPullStore

logger = logging.getLogger(__name__)


def migrate_pulled_to_references(
    pull_store: SkillPullStore,
    ref_store: SkillReferenceStore,
    skills_dir: Path,
) -> int:
    """把 pull store 里的已装市场 skill 转成引用并删本地文件。返回成功迁移条数。

    本地这份坏了（SKILL.md 缺失/损坏）→ 跳过、不写 null 引用（清理残留，让用户重新引用）。
    """
    pulled = pull_store.get_pulled_map()   # {"<source>:<remote_id>": "<folder>"}
    if not pulled:
        return 0

    skills_dir = Path(skills_dir)
    migrated = 0
    skipped = 0
    for key, folder in list(pulled.items()):
        source, _, remote_id = key.partition(":")
        folder_dir = skills_dir / folder

        name, desc, triggers, version = folder, None, [], None
        got_meta = False
        try:
            if (folder_dir / "SKILL.md").exists():
                meta, _ = load_skill_md(folder_dir)
                name = meta.name or folder
                desc = meta.description or None
                triggers = list(meta.triggers or [])
                version = getattr(meta, "version", None)
                got_meta = True
        except Exception:
            logger.warning("迁移：解析 '%s' 的 SKILL.md 失败", folder, exc_info=True)

        if not got_meta:
            # 本地这份坏了（SKILL.md 缺失/损坏）→ 拿不到正确元数据，就【不迁移】：绝不写 null 引用，
            # 也不覆盖已有的好引用。清掉损坏残留 + pull 记录（避免每次启动重试）；用户更新后从市场
            # 重新引用即可（pull() 会从云端重抽正确元数据）。若库里已有好引用则原样保留、无需重引。
            logger.warning("迁移：'%s' 本地已损坏，跳过迁移，请更新后重新引用", folder)
            shutil.rmtree(folder_dir, ignore_errors=True)
            pull_store.remove_pulled_by_folder(folder)
            skipped += 1
            continue

        ref_store.add_reference(SkillReference(
            identity=ReferenceIdentity(GENERAL_SCOPE, source, remote_id),  # 旧数据无引用者 → 共享主体
            name=name,
            description=desc,
            triggers=triggers,
            skill_version=version,
        ))
        # 市场 skill 改引用式 → 删掉本地解压文件（用户自建的不在 pull store，不受影响）。
        shutil.rmtree(folder_dir, ignore_errors=True)
        pull_store.remove_pulled_by_folder(folder)
        migrated += 1

    if migrated or skipped:
        logger.info("迁移完成：转为引用 %d 个，跳过损坏 %d 个（本地文件已清理）", migrated, skipped)
    return migrated
