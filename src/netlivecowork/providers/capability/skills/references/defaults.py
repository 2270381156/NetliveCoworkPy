"""随包「默认引用」的播种与坏数据清理。

**这不是迁移，是每次启动都要做的事**，所以没有跟着 legacy/ 走：

  * ``seed_default_references``：把随包预置的默认引用（内置 skill 上传云端后的 cowork
    引用）合并进用户引用库。用户删过的不复活；已存在的用随包元数据回填/纠正。
  * ``prune_null_references``：清掉 description 为空的坏引用（历史遗留 / 老构建 seed
    出来的 null）。

原先它俩与一次性迁移同住 migration.py。"每次都跑的"和"迁完就能删的"混在一个叫 migration
的文件里，后果是想清理时会发现有长期功能卡在里面——而文件名还骗你说它整个都是过渡物。

v3 起：防复活账本按 ``bundled_default_seed_id`` 记（与引用 hash 解耦）；"已存在"的
查询按**精确身份**（general 作用域 + principal）走 ``get_by_id``——库里同时有 general
和某个 profile 专属市场的同名条目时，播种只认 general 那条，不许误碰别人的。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from ..adapters import registry as market_registry
from ..adapters.scopes import GENERAL_SCOPE
from .store import (
    ANY_PRINCIPAL,
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
    bundled_default_seed_id,
)

logger = logging.getLogger(__name__)


def prune_null_references(ref_store: SkillReferenceStore) -> int:
    """删除 description 为空的坏引用（历史迁移遗留 / 老构建 seed 出来的 null）。

    在 seed_default_references 之后调用：默认 6 个已被随包文件回填、description 不为空，故不会被删；
    剩下 description 仍为空的（多是用户自己 pull 的坏数据）直接清掉——这种引用对 LLM 无用（没描述
    无法触发），用户需要可从市场重新引用（pull 会从云端重抽正确元数据）。返回删除条数。

    按**各自精确 ID** 删：同名对（general + scoped 同 source/remote_id）各删各的，不炸歧义。
    """
    removed = 0
    for ref in ref_store.list_references():
        if not (ref.description or "").strip():
            ref_store.remove_by_id(ref.key)
            logger.warning("清理空 description 的坏引用：%s（%s），可重新引用", ref.name, ref.key)
            removed += 1
    if removed:
        logger.info("共清理 %d 条 description 为空的坏引用", removed)
    return removed


def seed_default_references(default_file: Path, ref_store: SkillReferenceStore) -> int:
    """把随包预置的"默认引用"（内置 skill 上传云端后的 cowork 引用）合并进用户引用库。

    语义：
      - 库里【不存在】该精确身份：曾 seed 过（用户删了）→ 不复活；否则新增并记账。
      - 库里【已存在】该精确身份：用随包默认元数据【回填/纠正】其 name/description/triggers/version
        （修复历史上从 description=null 的旧构建 seed 出来的坏数据；principal/referenced_at 保留）。
        随包默认文件是这 6 个内置 skill 元数据的事实源，与云端一致，故直接以它为准。

    精确身份 = general 作用域 + source + remote_id + principal（按人可见的来源沿用随包
    owner，其余共享主体）。同一 source/remote_id 若还存在某个 profile 专属市场的引用，
    与本函数互不相干。

    每条的新增/回填 + 记账都在**同一个 ``mutate`` 事务**里提交。default_file 不存在
    则跳过。返回本次【新增 + 回填】的条数。
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
        if not isinstance(raw, dict):
            continue
        old = SkillReference.from_dict(raw)   # 随包文件是 v2 形状，换算在这里发生
        if not old.source or not old.remote_id:
            continue

        # principal：按人可见的来源沿用随包 owner，其余一律共享主体——不改既有可见范围。
        principal = (
            old.identity.principal
            if old.source in market_registry.per_user_sources()
            and old.identity.principal != ANY_PRINCIPAL
            else ANY_PRINCIPAL
        )
        identity = ReferenceIdentity(GENERAL_SCOPE, old.source, old.remote_id, principal)
        seed_id = bundled_default_seed_id(old.source, old.remote_id)

        counters = {"added": 0, "refreshed": 0}

        def apply(root: dict) -> None:
            was_seeded = seed_id in root["seeded_defaults"]
            rec = root["references"].get(identity.reference_id)
            if rec is not None:
                # 已存在 → 用随包默认元数据回填/纠正（bundled 非空优先，其余字段保留）；
                # 历史数据顺带补记账。
                existing = SkillReference.from_dict(rec)
                merged = SkillReference(
                    identity=identity,
                    name=old.name or existing.name,
                    description=old.description if old.description is not None else existing.description,
                    triggers=list(old.triggers or existing.triggers),
                    skill_version=old.skill_version or existing.skill_version,
                    referenced_at=existing.referenced_at,
                    manual_labels=existing.manual_labels,
                    preset_bindings=existing.preset_bindings,
                )
                if (merged.name, merged.description, list(merged.triggers), merged.skill_version) != (
                    existing.name, existing.description, list(existing.triggers), existing.skill_version
                ):
                    root["references"][identity.reference_id] = merged.to_dict()
                    counters["refreshed"] += 1
                if not was_seeded:
                    root["seeded_defaults"].append(seed_id)
                return
            # 不存在：曾 seed 过（用户删了）→ 不复活；否则新增并记账。
            if was_seeded:
                return
            root["seeded_defaults"].append(seed_id)
            root["references"][identity.reference_id] = SkillReference(
                identity=identity,
                name=old.name,
                description=old.description,
                triggers=list(old.triggers or []),
                skill_version=old.skill_version,
                referenced_at=old.referenced_at,
                manual_labels=old.manual_labels,
            ).to_dict()
            counters["added"] += 1

        ref_store.mutate(apply)
        added += counters["added"]
        refreshed += counters["refreshed"]

    if added or refreshed:
        logger.info("默认引用：新增 %d 条，回填/纠正元数据 %d 条", added, refreshed)
    return added + refreshed
