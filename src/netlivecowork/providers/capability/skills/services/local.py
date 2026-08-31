"""LocalSkillService — list/delete/import skills under skills_dir."""

from __future__ import annotations

import shutil
from pathlib import Path

from ctx_weft.providers.capability_skill_local._parser import load_skill_md

from ..errors import SkillError
from ..legacy import SkillPullStore
from ..runtime.zip_utils import extract_zip, sanitize_folder, validate_skill_zip, zip_dir_to_bytes


class LocalSkillService:
    def __init__(self, skills_dir: Path, pull_store: SkillPullStore) -> None:
        self._skills_dir = Path(skills_dir)
        self._pull_store = pull_store

    def list_skills(self) -> list[dict]:
        result: list[dict] = []
        if not self._skills_dir.exists():
            return result
        for skill_dir in sorted(self._skills_dir.iterdir()):
            if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").exists():
                continue
            try:
                meta, _ = load_skill_md(skill_dir)
            except Exception:
                continue
            result.append({
                "skill_id": skill_dir.name,
                "name": meta.name or skill_dir.name,
                "description": meta.description,
                "version": meta.version,
                "triggers": meta.triggers,
            })
        return result

    def delete_skill(self, skill_id: str) -> None:
        # Fast-fail on obvious cases; the resolve()/relative_to() check below
        # is the authoritative safety boundary.
        if not skill_id or "/" in skill_id or "\\" in skill_id or skill_id in (".", ".."):
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")

        skill_dir = (self._skills_dir / skill_id).resolve()
        try:
            skill_dir.relative_to(self._skills_dir.resolve())
        except ValueError:
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")

        if not skill_dir.exists() or not (skill_dir / "SKILL.md").exists():
            raise SkillError("LOCAL_SKILL_NOT_FOUND", f"Skill '{skill_id}' not found")

        try:
            shutil.rmtree(skill_dir)
        except Exception as e:
            raise SkillError("LOCAL_SKILL_DELETE_FAILED", f"Failed to delete skill '{skill_id}': {e}")

        self._pull_store.remove_pulled_by_folder(skill_id)

    def read_skill_zip(self, skill_id: str) -> tuple[bytes, str]:
        """把本地 skill 目录打成 (zip 字节, 文件名)，供上传到 cowork 市场。
        校验同 delete_skill：拒非法 id / 目录穿越 / 不存在。"""
        if not skill_id or "/" in skill_id or "\\" in skill_id or skill_id in (".", ".."):
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")
        skill_dir = (self._skills_dir / skill_id).resolve()
        try:
            skill_dir.relative_to(self._skills_dir.resolve())
        except ValueError:
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")
        if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").exists():
            raise SkillError("LOCAL_SKILL_NOT_FOUND", f"Skill '{skill_id}' not found")
        return zip_dir_to_bytes(skill_dir), f"{skill_dir.name}.zip"

    def import_skill(self, data: bytes) -> dict:
        name, _ = validate_skill_zip(data)
        folder_name = sanitize_folder(name)
        dest_dir = self._skills_dir / folder_name
        try:
            extract_zip(data, dest_dir)
            meta, _ = load_skill_md(dest_dir)
        except SkillError:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise
        except Exception as e:
            shutil.rmtree(dest_dir, ignore_errors=True)
            raise SkillError("IMPORT_EXTRACT_FAILED", f"解压失败: {e}")
        return {
            "skill_id": folder_name,
            "name": meta.name or folder_name,
            "description": meta.description,
            "version": meta.version,
            "triggers": meta.triggers,
        }
