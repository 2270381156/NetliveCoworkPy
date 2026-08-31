"""归属表要认两个 key：目录名，和 SKILL.md 里写的 name。

## 现场

用户在技能中心把一条本地 skill 勾给了某个 cowork，那个 agent 却说自己没有。

记录按 `skill_id` 存，而它是**目录名**（services/local.py: `skill_dir.name`）；
运行期问过来的是**能力名**，也就是 SKILL.md frontmatter 里的 `name`
（`meta.name or 目录名`）。目录叫 a、文件里写 `name: b` 的那些，两边永远对不上，
而**两边都不报错**——用户看到的是"勾了等于没勾"。

## 为什么不在读的一侧做反查

曾经写成"查不到就去 api.deps 拉服务、全量扫一遍 skill 目录"。两个问题：装配层反过来
够 api（方向反了），以及那是能力清单的热路径——每轮对话都要问一遍，而"查不到"对通用
skill 是**常态**。所以解析放在归属库自己，直查命中走 O(1)，只有对不上才建一次别名表。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from netlivecowork.providers.capability.skills.references.local_owners import LocalSkillOwners


def _skill(root: Path, dirname: str, name: str | None = None) -> Path:
    d = root / dirname
    d.mkdir(parents=True)
    front = f"---\nname: {name}\ndescription: x\n---\n\nbody\n" if name else "---\ndescription: x\n---\n\nbody\n"
    (d / "SKILL.md").write_text(front, encoding="utf-8")
    return d


@pytest.fixture
def env(tmp_path):
    data, skills = tmp_path / "data", tmp_path / "skills"
    data.mkdir()
    skills.mkdir()
    return data, skills


# ── 直查这条路（绝大多数 skill）────────────────────────────────────────────


def test_the_directory_name_still_works(env):
    data, skills = env
    _skill(skills, "docx", "docx")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("docx", ["ipmaster"])
    assert o.labels_of("docx") == ("ipmaster",)


def test_no_record_means_common(env):
    """存量 skill 一条记录都没有。读成"谁都不能用"会让用户已有的 skill 一夜消失。"""
    data, skills = env
    _skill(skills, "docx", "docx")
    assert LocalSkillOwners(data, skills_dir=skills).labels_of("docx") == ()


# ── 别名这条路（目录名与 SKILL.md 的 name 不一致）──────────────────────────


def test_the_name_in_skill_md_resolves_to_the_directory_record(env):
    """**这条就是那个 bug。** 归属按目录名 `topo` 存，运行期按 name `topology-drawing` 问。"""
    data, skills = env
    _skill(skills, "topo", "topology-drawing")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("topo", ["coremaster"])
    assert o.labels_of("topology-drawing") == ("coremaster",), "别名没解析，勾了等于没勾"


def test_an_unknown_name_is_still_common(env):
    data, skills = env
    _skill(skills, "topo", "topology-drawing")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("topo", ["coremaster"])
    assert o.labels_of("someone-else") == ()


def test_without_a_skills_dir_it_degrades_to_the_old_behaviour(env):
    """不给 skills_dir 就只认目录名——老行为，不会更差，也不该抛。"""
    data, skills = env
    _skill(skills, "topo", "topology-drawing")
    o = LocalSkillOwners(data)                     # 不传 skills_dir
    o.set_labels("topo", ["coremaster"])
    assert o.labels_of("topo") == ("coremaster",)
    assert o.labels_of("topology-drawing") == ()


def test_a_missing_skills_dir_is_not_an_error(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    o = LocalSkillOwners(data, skills_dir=tmp_path / "nope")
    assert o.labels_of("whatever") == ()


# ── 热路径：不能每次都扫目录 ────────────────────────────────────────────────


def test_a_direct_hit_never_builds_the_alias_map(env, monkeypatch):
    """**直查命中就不许扫目录。**

    能力清单每轮对话都要问一遍，而建别名表要解析每个 SKILL.md。
    这条钉的是"常见路径必须便宜"。
    """
    data, skills = env
    _skill(skills, "docx", "docx")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("docx", ["ipmaster"])

    called = []
    monkeypatch.setattr(o, "_alias_map", lambda: called.append(1) or {})
    o.labels_of("docx")
    assert not called, "直查明明命中了，还是去扫了目录"


def test_the_alias_map_is_cached_between_calls(env):
    """对不上时才建，而且只建一次——目录没变就不该重复解析。"""
    data, skills = env
    _skill(skills, "topo", "topology-drawing")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("topo", ["coremaster"])

    o.labels_of("topology-drawing")
    stamp = o._alias_stamp
    assert stamp is not None
    o.labels_of("topology-drawing")
    assert o._alias_stamp is stamp, "目录没变却重建了别名表"


def test_a_new_skill_invalidates_the_cache(env):
    """加了新 skill 就得重建——否则新导入的那条永远解析不出来。"""
    data, skills = env
    _skill(skills, "topo", "topology-drawing")
    o = LocalSkillOwners(data, skills_dir=skills)
    o.set_labels("topo", ["coremaster"])
    o.labels_of("topology-drawing")

    _skill(skills, "kb", "knowledge-base")
    o.set_labels("kb", ["ipmaster"])
    # 目录 mtime 变了 → 缓存作废 → 新的别名也能解析
    assert o.labels_of("knowledge-base") == ("ipmaster",)
