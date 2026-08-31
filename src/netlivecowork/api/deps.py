"""App-level singletons and FastAPI Depends() helpers.

All route modules import from here instead of main.py.
Setters are called during lifespan startup (startup.py).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from fastapi import HTTPException

from netlivecowork import paths
from netlivecowork.config import get_settings
from netlivecowork.providers.capability.skills.services.local import LocalSkillService
from netlivecowork.providers.capability.skills.services.market import SkillMarketService
from netlivecowork.providers.capability.skills.adapters import registry as market_registry
from netlivecowork.providers.capability.skills.references.store import SkillReferenceStore
from netlivecowork.providers.capability.skills.legacy import SkillPullStore

_runtime: Any = None
_template_store: Any = None
_agent_template_provider: Any = None
_template_syncer: Any = None
_hitl_manager: Any = None
_mcp_manager: Any = None
_bash_review_modes: Any = None
_rewind_manager: Any = None


# ── Setters (called from startup.py) ─────────────────────────────────────────

def set_runtime(r: Any) -> None:
    global _runtime; _runtime = r

def set_template_store(s: Any) -> None:
    global _template_store; _template_store = s

def set_agent_template_provider(p: Any) -> None:
    global _agent_template_provider; _agent_template_provider = p

def set_template_syncer(s: Any) -> None:
    global _template_syncer; _template_syncer = s

def set_hitl_manager(h: Any) -> None:
    global _hitl_manager; _hitl_manager = h

def set_mcp_manager(m: Any) -> None:
    global _mcp_manager; _mcp_manager = m

def set_bash_review_modes(store: Any) -> None:
    global _bash_review_modes; _bash_review_modes = store

def set_rewind_manager(m: Any) -> None:
    global _rewind_manager; _rewind_manager = m


def get_bash_review_modes() -> Any:
    """Soft accessor — returns None if not configured."""
    return _bash_review_modes

def get_rewind_manager() -> Any:
    """Soft accessor — returns None if rewind disabled / not configured."""
    return _rewind_manager


# ── Getters / Depends() ───────────────────────────────────────────────────────

def get_runtime() -> Any:
    if _runtime is None:
        raise HTTPException(status_code=503, detail="Runtime not initialized")
    return _runtime


def get_runtime_optional() -> Any:
    """Soft accessor — returns None if not configured (for best-effort paths like HITL self-heal)."""
    return _runtime


def get_template_store() -> Any:
    if _template_store is None:
        raise HTTPException(status_code=503, detail="TemplateStore not initialized")
    return _template_store


def get_agent_template_provider() -> Any:
    if _agent_template_provider is None:
        raise HTTPException(status_code=503, detail="Agent template provider not initialized")
    return _agent_template_provider


def get_template_syncer() -> Any:
    if _template_syncer is None:
        raise HTTPException(status_code=503, detail="TemplateSyncer not initialized")
    return _template_syncer


def get_hitl_manager() -> Any:
    """Soft dependency — returns None if not configured."""
    return _hitl_manager


def require_hitl_manager() -> Any:
    if _hitl_manager is None:
        raise HTTPException(status_code=503, detail="HitlManager not initialized")
    return _hitl_manager


def get_llm_provider() -> Any:
    rt = get_runtime()
    if not rt.providers.has_llm_provider():
        raise HTTPException(status_code=503, detail="LLMProvider not initialized")
    return rt.providers.get_llm_provider()


def get_mcp_manager() -> Any:
    if _mcp_manager is None:
        raise RuntimeError("MCPProviderManager not initialized")
    return _mcp_manager


# ── Skill management services ─────────────────────────────────────────────────

@lru_cache
def get_local_skill_service() -> LocalSkillService:
    return LocalSkillService(
        skills_dir=paths.skills_dir(),
        pull_store=SkillPullStore(paths.data_dir()),
    )


@lru_cache
def get_skill_reference_store() -> SkillReferenceStore:
    """云端引用库（云端 skill 引用式加载）。"""
    return SkillReferenceStore(paths.data_dir())


@lru_cache
def get_cowork_skill_service():
    """cowork 那家的 adapter，单独暴露：上传回市场只走它（别家不支持上传）。

    地址没配时抛 RuntimeError 并指向具体 env 键——这个判断连同"有哪几家市场"都在
    adapters/registry.py 里，本模块不再自己检查。
    """
    return market_registry.build_adapter("cowork", get_settings())


@lru_cache
def get_skill_market_service() -> SkillMarketService:
    """聚合市场：把 registry 装出来的几家合并、标 is_pulled、按 source 派发。

    **本函数不知道有哪几家**。加一家市场只改 adapters/registry.py 的那张表。
    """
    settings = get_settings()
    return SkillMarketService(
        adapters=market_registry.build_all(settings),
        store=SkillReferenceStore(paths.data_dir()),
        download_retries=settings.skill_download_retries,
        download_retry_delay_sec=settings.skill_download_retry_delay_sec,
        # 某个 cowork 自带的市场：地址在它自己的套件里，**每次现造不缓存**——权限收回后
        # 套件会被删掉，缓存住等于让一个已经没权限的市场继续可访问。
        scoped_adapters=lambda cid: market_registry.build_for_cowork(cid, settings),
    )
