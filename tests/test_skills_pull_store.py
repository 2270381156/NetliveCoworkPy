"""SkillPullStore: pulled-map persistence + reverse delete by folder."""
from __future__ import annotations

from netlivecowork.providers.capability.skills.legacy import SkillPullStore


def test_record_and_map(tmp_path):
    s = SkillPullStore(tmp_path)
    s.record_pulled("cowork", "r1", "folder-a")
    s.record_pulled("mythos", "r2", "folder-b")
    assert s.get_pulled_map() == {"cowork:r1": "folder-a", "mythos:r2": "folder-b"}
    assert (tmp_path / "skill_pull_config.json").exists()


def test_remove_by_folder(tmp_path):
    s = SkillPullStore(tmp_path)
    s.record_pulled("cowork", "r1", "folder-a")
    s.record_pulled("mythos", "r2", "folder-a")
    s.record_pulled("cowork", "r3", "folder-b")
    s.remove_pulled_by_folder("folder-a")
    assert s.get_pulled_map() == {"cowork:r3": "folder-b"}


def test_empty_when_missing(tmp_path):
    s = SkillPullStore(tmp_path)
    assert s.get_pulled_map() == {}
