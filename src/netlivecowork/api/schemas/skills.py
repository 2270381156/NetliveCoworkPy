"""Skill management response models (match frontend-desktop/src/api/skills.ts)."""

from __future__ import annotations

from pydantic import BaseModel


class LocalSkillResponse(BaseModel):
    skill_id: str
    name: str
    description: str
    version: str
    triggers: list[str]
    origin: str = "local"            # "local"（自建，永久存）| "cloud"（市场引用，用时下载）
    source: str | None = None        # 仅 cloud：来源市场 "cowork" | "mythos"（前端徽章用）
    # 归属：这条 skill 归哪些 cowork 用。``["*"]`` = 通用（谁都能用）。
    #
    # ⚠ **通用的也要显示**（需求 H7）：用户手里多数是通用 skill，
    # 通用不占位的话整个"归属"概念在界面上根本不存在，人就无从判断
    # 自己刚才的选择有没有生效。
    coworks: list[str] = ["*"]


class SkillMarketTab(BaseModel):
    """技能市场的一个页签。``cowork=None`` 是通用市场（不属于任何 cowork，恒存在）。"""
    cowork: str | None = None
    display_name: str


class RemoteCatalogItem(BaseModel):
    source: str               # "cowork" | "mythos" —— 程序用于下载路由，UI 不展示
    id: str
    name: str
    description: str | None
    updater: str | None = None
    create_time: str | None
    is_pulled: bool


class PullSkillResponse(BaseModel):
    skill_id: str
    name: str
