"""netlivecowork template provider.

  store.py     TemplateStore      元数据 JSON CRUD（data/templates/*.json）
  provider.py  DirAgentCapabilityProvider   store 元数据 + core TemplateLoader 按需加载
  syncer.py    TemplateSyncer     启动扫描 + 同步 store
"""

from ctx_weft.providers.agent_template_local import PROVIDER_NAME as AGENT_PROVIDER_NAME


def canonical_template_id(template_id: str) -> str:
    """ctx-weft 边界规范化：裸模板 id → 'agent:<id>'（spec 2026-07-22 边界强制前缀）。

    已含 ':'（任意 provider 前缀）原样返回。host 内部（模板管理 API / 前端 / DB 行）
    继续用裸 id——转换只发生在把 id 交给 ctx-weft 的边界。"""
    return template_id if ":" in template_id else f"{AGENT_PROVIDER_NAME}:{template_id}"
