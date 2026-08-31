"""Templates API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from . import deps
from .schemas.templates import (
    RegisterTemplateRequest,
    TemplateDetailResponse,
    TemplateSummaryResponse,
)

router = APIRouter(tags=["templates"])


@router.get("", response_model=list[TemplateSummaryResponse])
async def list_templates(store=Depends(deps.get_template_store)):
    return [
        TemplateSummaryResponse(
            id=d["id"], name=d["name"], version=d["version"],
            description=d.get("description") or "",
        )
        for d in await store.list_all()
    ]


@router.get("/{template_id}", response_model=TemplateDetailResponse)
async def get_template(template_id: str, provider=Depends(deps.get_agent_template_provider)):
    from ctx_weft.protocols.context import ProviderContext
    ctx = ProviderContext(session_id="", tenant_id="system")
    template = await provider.get_template(template_id, None, ctx)
    if template is None:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return TemplateDetailResponse(
        id=template.id,
        name=template.name,
        version=template.version,
        description=template.description,
        tool_refs=[ref.capability_id for ref in template.capability_refs],
        has_soul="act" in template.identity,
        has_role="observe" in template.identity,
    )


@router.post("/register", response_model=TemplateSummaryResponse, status_code=201)
async def register_template(
    req: RegisterTemplateRequest,
    syncer=Depends(deps.get_template_syncer),
):
    from pathlib import Path
    template_dir = Path(req.template_dir)
    if not template_dir.exists() or not (template_dir / "SOUL.md").exists():
        raise HTTPException(status_code=400, detail="Directory not found or missing SOUL.md")
    try:
        template_id = await syncer.sync_one(template_dir)
        meta = await syncer.store.get(template_id)
        return TemplateSummaryResponse(
            id=meta["id"], name=meta["name"],
            version=meta["version"], description=meta.get("description", ""),
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{template_id}", status_code=204)
async def delete_template(template_id: str, syncer=Depends(deps.get_template_syncer)):
    if not await syncer.store.delete(template_id):
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
