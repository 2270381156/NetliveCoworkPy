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


def _template_id_of(template_dir: Path, template: object) -> str:
    """模板 id 以**目录名**为准，不以文件里写的为准。

    目录名就是 cowork id，而 cowork id 是这个系统里到处在用的身份：会话的 template_id、
    entitled.json 的清单、skill 的归属、LLM 的 allow 名单，全都是它。SOUL.md 里的 name
    只是套件作者写的一行字。

    两者不一致的后果是**一个装了却用不了的智能体**：`/coworks` 按目录列，界面上有它；
    模板却注册在文件里那个名字下，建会话时按 cowork id 查不到，一路抛成

        TemplateNotFoundError: Template 'agent:ipmaster' not found

    → 前端只看到一行 500。用户明明有权限，问题在打包。更糟的是同名互相覆盖：几个套件
    的 SOUL.md 都写 name: default 的话，7 个目录只入库一条，最后扫到谁就指向谁。

    所以这里以目录名为准让它能用，同时把不一致喊出来给运维看：
    能用是对用户的，日志是给修包的人的。
    """
    from_file = str(getattr(template, "id", "") or "").strip()
    tid = template_dir.name
    if from_file and from_file != tid:
        logger.warning(
            "TemplateSyncer: 套件目录 '%s' 里的 SOUL.md 写的是 name=%r，两者不一致。"
            "已按目录名注册（cowork id 才是身份）；请修正这个套件的 SOUL.md。",
            tid, from_file,
        )
    return tid


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
            tid = _template_id_of(template_dir, template)
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
            "id": _template_id_of(template_dir, template),
            "name": template.name,
            "version": template.version,
            "description": template.description,
            "template_dir": str(template_dir.resolve()),
        })
        tid = _template_id_of(template_dir, template)
        logger.info("TemplateSyncer: registered template '%s' from '%s'", tid, template_dir)
        return tid
