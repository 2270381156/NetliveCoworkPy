"""zip_utils: folder slug, skill-zip validation, single-root extraction."""
from __future__ import annotations

import io
import zipfile

import pytest

from netlivecowork.providers.capability.skills.errors import SkillError
from netlivecowork.providers.capability.skills.runtime import zip_utils


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


_GOOD_MD = "---\nname: My Skill\ndescription: does things\nversion: 2.0\n---\nbody"


def test_sanitize_folder():
    assert zip_utils.sanitize_folder("My Skill!") == "my-skill"
    assert zip_utils.sanitize_folder("  ") == "skill"
    # Unicode 保留：中文不再被整段删成 'skill'
    assert zip_utils.sanitize_folder("调用量上报") == "调用量上报"
    assert zip_utils.sanitize_folder("PDF 摘要") == "pdf-摘要"
    # 路径穿越/非法字符被中和
    assert zip_utils.sanitize_folder("../etc/passwd") == "etc-passwd"
    assert "/" not in zip_utils.sanitize_folder("a/b:c*d")


def test_validate_ok_with_single_root():
    name, desc = zip_utils.validate_skill_zip(_zip({"my-skill/SKILL.md": _GOOD_MD}))
    assert name == "My Skill"
    assert desc == "does things"


def test_validate_not_a_zip():
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(b"not a zip")
    assert e.value.code == "IMPORT_INVALID_ZIP"


def test_validate_missing_skill_md():
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"readme.txt": "hi"}))
    assert e.value.code == "IMPORT_MISSING_SKILL_MD"


def test_validate_missing_name():
    md = "---\ndescription: only desc\n---\nbody"
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"SKILL.md": md}))
    assert e.value.code == "IMPORT_MISSING_NAME"


def test_extract_flattens_single_root(tmp_path):
    data = _zip({"my-skill/SKILL.md": _GOOD_MD, "my-skill/scripts/run.py": "print(1)"})
    dest = tmp_path / "out"
    zip_utils.extract_zip(data, dest)
    assert (dest / "SKILL.md").read_text(encoding="utf-8") == _GOOD_MD
    assert (dest / "scripts" / "run.py").exists()


def test_validate_ok_flat_root():
    name, desc = zip_utils.validate_skill_zip(_zip({"SKILL.md": _GOOD_MD}))
    assert name == "My Skill"
    assert desc == "does things"


def test_validate_missing_description():
    md = "---\nname: Only Name\n---\nbody"
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"SKILL.md": md}))
    assert e.value.code == "IMPORT_MISSING_DESCRIPTION"


def test_validate_malformed_yaml_frontmatter():
    # `>"..."` 混用折叠块标量与双引号，是非法 YAML，PyYAML 会抛 ScannerError。
    # 期望被转成 SkillError(400)，而不是逃逸成 500。
    md = '---\nname: Bad\ndescription: >"line1\\nline2"\n---\nbody'
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"SKILL.md": md}))
    assert e.value.code == "IMPORT_INVALID_YAML"


def test_extract_rejects_path_traversal(tmp_path):
    data = _zip({"my-skill/SKILL.md": _GOOD_MD, "my-skill/sub/../../evil.txt": "x"})
    with pytest.raises(SkillError) as e:
        zip_utils.extract_zip(data, tmp_path / "out")
    assert e.value.code == "IMPORT_INVALID_ZIP"
