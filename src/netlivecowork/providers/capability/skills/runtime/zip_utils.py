"""ZIP helpers: validate a skill zip and extract it (single-root flattening)."""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

import yaml

from ctx_weft.providers.capability_skill_local._parser import parse_skill_md

from ..errors import SkillError


def sanitize_folder(name: str) -> str:
    r"""Filesystem-safe folder name, preserving Unicode letters/digits (incl. 中文).

    \w 在 Python3 str 正则下默认 Unicode 感知：保留任意语言的字母/数字和下划线，
    把其余字符（空格、标点、路径分隔符 / \ : 等）的连续段折成单个 '-'。
    例：'调用量上报' → '调用量上报'，'My Skill!' → 'my-skill'。
    与旧版（仅 [a-z0-9]）相比，ASCII 结果不变，但不再把中文整段删成 'skill'。
    """
    slug = re.sub(r"[^\w]+", "-", name.lower()).strip("-")
    return slug or "skill"


def _find_skill_md(names: list[str]) -> str | None:
    top_level = {n.split("/")[0] for n in names}
    single_root = len(top_level) == 1 and all(
        n.startswith(next(iter(top_level)) + "/") for n in names
    )
    candidate = f"{next(iter(top_level))}/SKILL.md" if single_root else "SKILL.md"
    return candidate if candidate in names else None


def validate_skill_zip(data: bytes) -> tuple[str, str]:
    """Validate the zip, return (name, description). Raises SkillError on failure."""
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise SkillError("IMPORT_INVALID_ZIP", "上传的文件不是有效的 ZIP 包")

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if not names:
            raise SkillError("IMPORT_INVALID_ZIP", "ZIP 包为空")
        skill_md_path = _find_skill_md(names)
        if skill_md_path is None:
            raise SkillError("IMPORT_MISSING_SKILL_MD", "ZIP 包中未找到 SKILL.md")
        try:
            content = zf.read(skill_md_path).decode("utf-8")
        except Exception as e:
            raise SkillError("IMPORT_INVALID_ZIP", f"无法读取 SKILL.md: {e}")

    try:
        meta, _ = parse_skill_md(content)
    except yaml.YAMLError as e:
        raise SkillError(
            "IMPORT_INVALID_YAML",
            f"SKILL.md frontmatter 不是合法的 YAML 格式：{e}",
        )
    if not meta.name:
        raise SkillError("IMPORT_MISSING_NAME", "SKILL.md frontmatter 缺少 name 字段")
    if not meta.description:
        raise SkillError("IMPORT_MISSING_DESCRIPTION", "SKILL.md frontmatter 缺少 description 字段")
    return meta.name, meta.description


def zip_dir_to_bytes(src_dir: Path) -> bytes:
    """把一个 skill 目录的内容打成 zip 字节（SKILL.md 在根、references/、scripts/…），
    跳过点文件/点目录。用于把本地 skill 上传到市场（extract_zip 的逆操作）。"""
    src_dir = Path(src_dir)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src_dir.rglob("*")):
            rel = p.relative_to(src_dir)
            if any(part.startswith(".") for part in rel.parts):
                continue  # 跳过 .git / .DS_Store 之类
            if p.is_file():
                zf.write(p, rel.as_posix())
    return buf.getvalue()


def extract_zip(data: bytes, dest_dir: Path) -> None:
    """Extract zip into dest_dir; if it has a single top-level dir, flatten it."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if not names:
            raise SkillError("IMPORT_INVALID_ZIP", "ZIP 包为空")
        top_level = {n.split("/")[0] for n in names}
        single_root = len(top_level) == 1 and all(
            n.startswith(next(iter(top_level)) + "/") for n in names
        )
        root_prefix = (next(iter(top_level)) + "/") if single_root else ""

        dest_dir = Path(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        for member in zf.infolist():
            rel_path = member.filename
            if root_prefix:
                if not rel_path.startswith(root_prefix):
                    continue
                rel_path = rel_path[len(root_prefix):]
            if not rel_path:
                continue
            target = dest_dir / rel_path
            if not target.resolve().is_relative_to(dest_dir.resolve()):
                raise SkillError("IMPORT_INVALID_ZIP", f"ZIP 包含非法路径: {member.filename}")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(member.filename))
