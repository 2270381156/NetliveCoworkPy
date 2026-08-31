"""LocalSkillService: import -> list -> delete roundtrip + guards."""
from __future__ import annotations

import io
import zipfile

import pytest

from netlivecowork.providers.capability.skills.errors import SkillError
from netlivecowork.providers.capability.skills.services.local import LocalSkillService
from netlivecowork.providers.capability.skills.legacy import SkillPullStore


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


_MD = (
    "---\nname: My Skill\ndescription: does things\nversion: 2.0\n"
    "triggers:\n  - foo\n  - bar\n---\nbody"
)


@pytest.fixture
def svc(tmp_path):
    skills = tmp_path / "skills"
    skills.mkdir()
    return LocalSkillService(skills_dir=skills, pull_store=SkillPullStore(tmp_path / "data"))


def test_import_then_list(svc):
    meta = svc.import_skill(_zip({"my-skill/SKILL.md": _MD}))
    assert meta["skill_id"] == "my-skill"
    assert meta["name"] == "My Skill"
    listing = svc.list_skills()
    assert len(listing) == 1
    assert listing[0]["skill_id"] == "my-skill"
    assert listing[0]["version"] == "2.0"
    assert listing[0]["triggers"] == ["foo", "bar"]


def test_delete(svc):
    svc.import_skill(_zip({"my-skill/SKILL.md": _MD}))
    svc.delete_skill("my-skill")
    assert svc.list_skills() == []


def test_delete_not_found(svc):
    with pytest.raises(SkillError) as e:
        svc.delete_skill("nope")
    assert e.value.code == "LOCAL_SKILL_NOT_FOUND"


def test_delete_path_traversal(svc):
    with pytest.raises(SkillError) as e:
        svc.delete_skill("../evil")
    assert e.value.code == "LOCAL_SKILL_INVALID_ID"


def test_import_cleans_up_on_extract_failure(svc):
    # Valid SKILL.md at the single root (passes validate) + a traversal entry
    # that makes extract_zip raise after dest_dir was partially written.
    data = _zip({"my-skill/SKILL.md": _MD, "my-skill/sub/../../evil.txt": "x"})
    with pytest.raises(SkillError) as e:
        svc.import_skill(data)
    assert e.value.code == "IMPORT_INVALID_ZIP"
    assert svc.list_skills() == []
