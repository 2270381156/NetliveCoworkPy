"""随包「默认引用」的播种与坏数据清理。

**这不是迁移，是每次启动都要做的事**，所以没有跟着 legacy/ 走：

  * ``seed_default_references``：把随包预置的默认引用（内置 skill 上传云端后的 cowork
    引用）合并进用户引用库。用户删过的不复活；已存在的用随包元数据回填/纠正。
  * ``prune_null_references``：清掉 description 为空的坏引用（历史遗留 / 老构建 seed
    出来的 null）。

原先它俩与一次性迁移同住 migration.py。"每次都跑的"和"迁完就能删的"混在一个叫 migration
的文件里，后果是想清理时会发现有长期功能卡在里面——而文件名还骗你说它整个都是过渡物。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .store import SkillReference, SkillReferenceStore

logger = logging.getLogger(__name__)


def prune_null_references(ref_store: SkillReferenceStore) -> int:
    """删除 description 为空的坏引用（历史迁移遗留 / 老构建 seed 出来的 null）。

    在 seed_default_references 之后调用：默认 6 个已被随包文件回填、description 不为空，故不会被删；
    剩下 description 仍为空的（多是用户自己 pull 的坏数据）直接清掉——这种引用对 LLM 无用（没描述
    无法触发），用户需要可从市场重新引用（pull 会从云端重抽正确元数据）。返回删除条数。
    """
    removed = 0
    for ref in ref_store.list_references():
        if not (ref.description or "").strip():
            ref_store.remove_reference(ref.source, ref.remote_id)
            logger.warning("清理空 description 的坏引用：%s（%s），可重新引用", ref.name, ref.key)
            removed += 1
    if removed:
        logger.info("共清理 %d 条 description 为空的坏引用", removed)
    return removed


def seed_default_references(default_file: Path, ref_store: SkillReferenceStore) -> int:
    """把随包预置的"默认引用"（内置 skill 上传云端后的 cowork 引用）合并进用户引用库。

    语义：
      - 库里【不存在】该 key：曾 seed 过（用户删了）→ 不复活；否则新增并记账。
      - 库里【已存在】该 key：用随包默认元数据【回填/纠正】其 name/description/triggers/version
        （修复历史上从 description=null 的旧构建 seed 出来的坏数据；owner/referenced_at 保留）。
        随包默认文件是这 6 个内置 skill 元数据的事实源，与云端一致，故直接以它为准。

    default_file 不存在则跳过。返回本次【新增 + 回填】的条数。
    """
    default_file = Path(default_file)
    if not default_file.exists():
        return 0
    try:
        data = json.loads(default_file.read_text(encoding="utf-8"))
        refs = data.get("references", {})
    except Exception:
        logger.warning("默认引用文件解析失败：%s", default_file, exc_info=True)
        return 0

    added = 0
    refreshed = 0
    for raw in refs.values():
        ref = SkillReference.from_dict(raw)
        if not ref.source or not ref.remote_id:
            continue

        existing = ref_store.get_reference(ref.source, ref.remote_id)
        if existing is not None:
            # 已存在 → 用随包默认元数据回填/纠正（bundled 非空优先，保留 owner/referenced_at）。
            merged = SkillReference(
                source=ref.source,
                remote_id=ref.remote_id,
                name=ref.name or existing.name,
                description=ref.description if ref.description is not None else existing.description,
                triggers=ref.triggers or existing.triggers,
                skill_version=ref.skill_version or existing.skill_version,
                owner=existing.owner,
                referenced_at=existing.referenced_at,
            )
            if (merged.name, merged.description, list(merged.triggers), merged.skill_version) != (
                existing.name, existing.description, list(existing.triggers), existing.skill_version
            ):
                ref_store.add_reference(merged)   # add_reference 按 key upsert
                refreshed += 1
            if not ref_store.was_default_seeded(ref.key):
                ref_store.mark_default_seeded(ref.key)   # 历史数据补记账
            continue

        # 不存在：曾 seed 过（用户删了）→ 不复活；否则新增。
        if ref_store.was_default_seeded(ref.key):
            continue
        ref_store.mark_default_seeded(ref.key)
        ref_store.add_reference(ref)
        added += 1

    if added or refreshed:
        logger.info("默认引用：新增 %d 条，回填/纠正元数据 %d 条", added, refreshed)
    return added + refreshed
