from __future__ import annotations

from pydantic import BaseModel, Field


class TemplateSummaryResponse(BaseModel):
    id: str
    name: str
    version: str
    description: str


class TemplateDetailResponse(BaseModel):
    id: str
    name: str
    version: str
    description: str
    tool_refs: list[str]
    has_soul: bool
    has_role: bool


class RegisterTemplateRequest(BaseModel):
    template_dir: str = Field(..., description="模板目录的绝对路径，需包含 SOUL.md")
