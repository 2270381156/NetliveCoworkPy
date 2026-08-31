"""TemplateStore — agent template 元数据持久化。

有 DB（session_factory 注入后）：写入 agent_templates 表，跨重启持久。
无 DB（session_factory=None）：退化为内存 dict，仅本次进程有效，重启后从目录重新 sync。

存储字段：id / name / version / description / template_dir（仅元数据）。
SOUL/ROLE 文本和 capability_refs 在 DirAgentCapabilityProvider.get_template() 时从磁盘按需读取。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class TemplateStore:
    """异步 template 元数据存储。"""

    def __init__(self, session_factory: Any = None) -> None:
        self._factory = session_factory          # sqlalchemy async_sessionmaker | None
        self._memory: dict[str, dict] = {}       # fallback when no DB

    def set_session_factory(self, factory: Any) -> None:
        """lifespan 初始化 DB 后注入 session factory。"""
        self._factory = factory

    # ── 公开 API（全部 async）────────────────────────────────────────────────

    async def save(self, data: dict[str, Any]) -> None:
        if self._factory:
            await self._db_save(data)
        else:
            self._memory[data["id"]] = dict(data)

    async def get(self, template_id: str) -> dict[str, Any] | None:
        if self._factory:
            return await self._db_get(template_id)
        return self._memory.get(template_id)

    async def delete(self, template_id: str) -> bool:
        if self._factory:
            return await self._db_delete(template_id)
        return self._memory.pop(template_id, None) is not None

    async def list_all(self) -> list[dict[str, Any]]:
        if self._factory:
            return await self._db_list()
        return list(self._memory.values())

    async def find_by_name(self, name: str) -> dict[str, Any] | None:
        for d in await self.list_all():
            if d.get("name") == name:
                return d
        return None

    # ── DB 实现 ───────────────────────────────────────────────────────────────

    async def _db_save(self, data: dict[str, Any]) -> None:
        from sqlalchemy import select
        from netlivecowork.persistence.postgres.models import AgentTemplateModel
        async with self._factory() as session:
            result = await session.execute(
                select(AgentTemplateModel).where(AgentTemplateModel.id == data["id"])
            )
            existing = result.scalar_one_or_none()
            if existing:
                existing.name = data["name"]
                existing.version = data["version"]
                existing.description = data.get("description", "")
                existing.template_dir = data["template_dir"]
            else:
                session.add(AgentTemplateModel(
                    id=data["id"],
                    name=data["name"],
                    version=data["version"],
                    description=data.get("description", ""),
                    template_dir=data["template_dir"],
                ))
            await session.commit()

    async def _db_get(self, template_id: str) -> dict[str, Any] | None:
        from sqlalchemy import select
        from netlivecowork.persistence.postgres.models import AgentTemplateModel
        async with self._factory() as session:
            result = await session.execute(
                select(AgentTemplateModel).where(AgentTemplateModel.id == template_id)
            )
            row = result.scalar_one_or_none()
            return _row_to_dict(row) if row else None

    async def _db_delete(self, template_id: str) -> bool:
        from sqlalchemy import select, delete
        from netlivecowork.persistence.postgres.models import AgentTemplateModel
        async with self._factory() as session:
            result = await session.execute(
                select(AgentTemplateModel).where(AgentTemplateModel.id == template_id)
            )
            if result.scalar_one_or_none() is None:
                return False
            await session.execute(
                delete(AgentTemplateModel).where(AgentTemplateModel.id == template_id)
            )
            await session.commit()
            return True

    async def _db_list(self) -> list[dict[str, Any]]:
        from sqlalchemy import select
        from netlivecowork.persistence.postgres.models import AgentTemplateModel
        async with self._factory() as session:
            result = await session.execute(select(AgentTemplateModel))
            return [_row_to_dict(row) for row in result.scalars().all()]


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "version": row.version,
        "description": row.description,
        "template_dir": row.template_dir,
    }
