"""DirAgentCapabilityProvider：TemplateStore（DB 元数据）+ core TemplateLoader。

方案 B（spec 2026-07-22 unification）：TemplateResolver 协议已删，host 直接实现
AgentCapabilityProvider。get() 语义原样自 TemplateDirResolver 平移：store 查
meta（get → find_by_name 回落）→ 磁盘按需 load（热更新友好）→ 非 default 模板
从 default 补缺省 facet。miss 返回 None（协议契约，由 TemplateLookup 转
TemplateNotFoundError）。
"""

from __future__ import annotations

import dataclasses
import logging
from collections.abc import Callable
from pathlib import Path

from ctx_weft.protocols.capability import (
    AgentCapability,
    AgentCapabilityProvider,
    Capability,
    CapabilityProviderInfo,
)
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.protocols.template import AgentTemplate
from ctx_weft.providers.agent_template_local import (
    DEFAULT_MERGE_PURPOSES,
    PROVIDER_NAME,
    TemplateLoader,
    merge_default_facets,
)
from netlivecowork.providers.templates.store import TemplateStore

logger = logging.getLogger(__name__)


class DirAgentCapabilityProvider(AgentCapabilityProvider):
    name = PROVIDER_NAME

    def __init__(
        self,
        store: TemplateStore,
        loader: TemplateLoader | None = None,
        default_template_id: str = "default",
        workspace_lookup: Callable[[str], str | None] | None = None,
    ) -> None:
        self._store = store
        self._loader = loader or TemplateLoader()
        self._default_template_id = default_template_id
        # session_id → 工作目录绝对路径（未登记返回 None）。用于把工作目录写进 SOUL 系统提示，
        # 让模型主动知道自己在哪、相对路径锚在哪。构造时 fs provider 常还没建好，故也支持后置注入。
        self._workspace_lookup = workspace_lookup

    def set_workspace_lookup(self, lookup: Callable[[str], str | None]) -> None:
        """后置注入 workspace 查询（cli 里 fs provider 晚于本 provider 构造，故构造后再接线）。"""
        self._workspace_lookup = lookup

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        try:
            rows = await self._store.list_all()
        except Exception:
            logger.exception("DirAgentCapabilityProvider: list_all failed")
            return []
        return [
            AgentCapability(
                id=f"{PROVIDER_NAME}:{d['id']}",
                name=d["id"],
                template_name=d["id"],
                # DB 描述列可空：None 必须归一 ""（原 resolver 的回归语义保留）
                description=d.get("description") or "",
                version=d.get("version") or "",
            )
            for d in rows
        ]

    async def get_template(
        self, template_id: str, version: str | None, ctx: ProviderContext,
    ) -> AgentTemplate | None:
        meta = await self._store.get(template_id)
        if meta is None:
            meta = await self._store.find_by_name(template_id)
        if meta is None:
            return None
        template = self._loader.load(Path(meta["template_dir"]))
        if template.id != self._default_template_id:
            default = await self._load_default()
            if default is not None:
                merge_default_facets(template, default, DEFAULT_MERGE_PURPOSES)
        self._inject_workspace(template, ctx)
        return template

    def _inject_workspace(self, template: AgentTemplate, ctx: ProviderContext) -> None:
        """把本会话的工作目录追加进 act facet（SOUL 正文），让模型主动获知工作区。

        loader.load 每次返回全新 template（非缓存），故就地改这一份不污染其它会话。仅注入 act
        （执行/用工具的身份）——observe/compact/metadata 是内部摘要任务，不碰文件、无需工作区。
        取不到工作区（未登记/无 lookup/无 session）时静默跳过，不影响原提示。
        """
        sid = getattr(ctx, "session_id", None)
        if not self._workspace_lookup or not sid:
            return
        try:
            ws = self._workspace_lookup(sid)
        except Exception:
            logger.debug("workspace_lookup 失败，跳过 SOUL 工作区注入", exc_info=True)
            return
        act = template.identity.get("act")
        if not ws or act is None:
            return
        note = (
            f"\n\n## 工作目录\n\n"
            f"你的工作目录是 `{ws}`。尽量把产出的文件都放在工作目录内，写到工作目录之外可能被拦截。"
        )
        template.identity["act"] = dataclasses.replace(act, text=act.text + note)

    async def _load_default(self) -> AgentTemplate | None:
        try:
            meta = await self._store.get(self._default_template_id)
            if meta is None:
                meta = await self._store.find_by_name(self._default_template_id)
            if meta is None:
                return None
            return self._loader.load(Path(meta["template_dir"]))
        except Exception:
            logger.exception("DirAgentCapabilityProvider: failed to load default template")
            return None

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        try:
            count = len(await self._store.list_all())
        except Exception:
            count = 0
        return CapabilityProviderInfo(
            name=self.name, capability_count=count,
            supports_streaming=False, supports_cancel=False,
            description=self.description,
        )
