"""Route layer: error-code -> HTTP status mapping + list happy path."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from netlivecowork.api import skills as skills_api
from netlivecowork.providers.capability.skills.errors import SkillError


class _FakeLocal:
    def __init__(self, listing=None, raises=None):
        self._listing = listing or []
        self._raises = raises

    def list_skills(self):
        return self._listing

    def delete_skill(self, skill_id):
        if self._raises:
            raise self._raises


class _FakeRefStore:
    def __init__(self, refs=None):
        self._refs = refs or []
        self.removed = []

    def list_visible(self, username, per_user_sources=frozenset()):
        return self._refs

    def remove_reference(self, source, remote_id):
        self.removed.append((source, remote_id))


def test_list_maps_to_response():
    svc = _FakeLocal(listing=[{
        "skill_id": "a", "name": "A", "description": "d", "version": "1.0", "triggers": ["t"],
    }])
    out = skills_api.list_local_skills(service=svc, ref_store=_FakeRefStore())
    assert out[0].skill_id == "a"
    assert out[0].triggers == ["t"]
    assert out[0].origin == "local"


def test_list_includes_cloud_references():
    from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
    from netlivecowork.providers.capability.skills.references.store import ReferenceIdentity, SkillReference
    svc = _FakeLocal(listing=[])
    ref = SkillReference(
        identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "m1"), name="Cloud",
        description="c", triggers=["x"])
    out = skills_api.list_local_skills(service=svc, ref_store=_FakeRefStore([ref]))
    assert out[0].origin == "cloud"
    assert out[0].source == "mythos"
    assert out[0].skill_id == ref.key   # v3 起是不透明 reference_id


def test_delete_cloud_removes_reference():
    rs = _FakeRefStore()
    skills_api.delete_local_skill("mythos:m1", service=_FakeLocal(), ref_store=rs)
    assert rs.removed == [("mythos", "m1")]


def test_delete_not_found_maps_to_404():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_NOT_FOUND", "nope"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill("x", service=svc, ref_store=_FakeRefStore())
    assert e.value.status_code == 404
    assert e.value.detail["code"] == "LOCAL_SKILL_NOT_FOUND"


def test_delete_invalid_id_maps_to_400():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_INVALID_ID", "bad"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill("../x", service=svc, ref_store=_FakeRefStore())
    assert e.value.status_code == 400


class _FakeMarket:
    def __init__(self, result=None, raises=None):
        self._result = result or {}
        self._raises = raises
        self.calls = []

    def per_user_sources(self):
        return {"mythos"}

    def pull(self, source, remote_id, name, username, cowork=None):
        self.calls.append((source, remote_id, name, username, cowork))
        if self._raises:
            raise self._raises
        return self._result


def test_pull_skill_happy_path():
    svc = _FakeMarket(result={"skill_id": "remote-skill", "name": "Remote Skill"})
    out = skills_api.pull_skill(
        "r9", {"name": "Remote Skill", "source": "mythos", "username": "a001"}, service=svc)
    assert out.skill_id == "remote-skill"
    # source/username/cowork 都要原样转下去：cowork 决定去哪家下载，也决定这条引用的归属。
    assert svc.calls == [("mythos", "r9", "Remote Skill", "a001", None)]


def test_pull_skill_blank_name_maps_to_400():
    svc = _FakeMarket()
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "  ", "source": "cowork"}, service=svc)
    assert e.value.status_code == 400
    assert e.value.detail["code"] == "MISSING_NAME"


def test_pull_skill_missing_source_maps_to_400():
    svc = _FakeMarket()
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "X"}, service=svc)
    assert e.value.status_code == 400
    assert e.value.detail["code"] == "MISSING_SOURCE"


def test_pull_skill_maps_remote_not_found_to_404():
    svc = _FakeMarket(raises=SkillError("REMOTE_SKILL_NOT_FOUND", "gone"))
    with pytest.raises(HTTPException) as e:
        skills_api.pull_skill("r9", {"name": "X", "source": "cowork"}, service=svc)
    assert e.value.status_code == 404
