"""TemplateSyncer — 扫描 agents 目录，同步元数据到 TemplateStore（async）。

启动时在 lifespan 里 await sync(agents_dir)：
  - 扫描目录下所有子目录的 SOUL.md
  - upsert 元数据到 store（id/name/version/description/template_dir）
  - 删除 store 中已不存在于目录的条目（仅 DB 模式，内存模式不删除）
"""

from __future__ import annotations

import logging
from pathlib import Path

from ctx_weft.providers.agent_template_local import TemplateLoader
from netlivecowork.providers.templates.store import TemplateStore

logger = logging.getLogger(__name__)


class TemplateSyncer:

    def __init__(self, store: TemplateStore, loader: TemplateLoader) -> None:
        self._store = store
        self._loader = loader

    @property
    def store(self) -> TemplateStore:
        return self._store

    async def sync(self, agents_dir: Path) -> int:
        """扫描 agents_dir，upsert 元数据到 store，删除已消失的条目。返回同步数量。"""
        scanned = self._loader.scan(agents_dir)
        synced_ids: set[str] = set()

        for template_dir, template in scanned:
            tid = template.id
            synced_ids.add(tid)
            await self._store.save({
                "id": tid,
                "name": template.name,
                "version": template.version,
                "description": template.description,
                "template_dir": str(template_dir.resolve()),
            })

        # 删除已不存在于目录的条目
        for existing in await self._store.list_all():
            if existing["id"] not in synced_ids:
                await self._store.delete(existing["id"])
                logger.debug("TemplateSyncer: removed stale template '%s'", existing.get("name"))

        logger.info("TemplateSyncer: synced %d template(s) from '%s'", len(scanned), agents_dir)
        return len(scanned)

    async def sync_one(self, template_dir: Path) -> str:
        """注册单个 template 目录，返回 template id。"""
        template = self._loader.load(template_dir)
        await self._store.save({
            "id": template.id,
            "name": template.name,
            "version": template.version,
            "description": template.description,
            "template_dir": str(template_dir.resolve()),
        })
        logger.info("TemplateSyncer: registered template '%s' from '%s'", template.id, template_dir)
        return template.id
