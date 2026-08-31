"""已装清单 —— "这台机器上现在装了哪几个"。

这份清单是**权限的落点**：它既决定界面列什么，也决定实际能跑什么。
所以这里的用例大多在问："某个东西不对劲时，会不会把整份清单带塌"——
带塌的表现是"一个 cowork 都没有"，而那与"没权限"长得一模一样。
"""
from __future__ import annotations

import json

from netlivecowork.cowork import installed
from netlivecowork.cowork.manifest import MASTER_ID


def _install(root, cid, *, version="1.0.0", order=10, **extra):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    raw = {"id": cid, "version": version, "order": order,
           "branding": {"displayName": cid.upper()}, **extra}
    (d / "cowork.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    return d


# ── 正常路径 ──────────────────────────────────────────────────────────────────

def test_lists_what_is_installed(tmp_path):
    _install(tmp_path, "ipmaster")
    _install(tmp_path, "mbb")
    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster", "mbb"]


def test_sorted_by_order_then_id(tmp_path):
    """次序由套件自己声明。

    **相同次序时还要按 id 定序**：不定序的话界面排列会随文件系统枚举顺序抖动，
    用户会觉得"每次打开顺序都不一样"，而这既不报错也无从复现。
    """
    _install(tmp_path, "c", order=10)
    _install(tmp_path, "a", order=20)
    _install(tmp_path, "b", order=10)
    assert [c.id for c in installed.list_all(tmp_path)] == ["b", "c", "a"]


def test_missing_dir_is_empty_not_an_error(tmp_path):
    """**目录不存在 = 一个都没装，不是错误。**

    全新安装、或授权对账还没跑过时就是这样。抛错会把一个正常状态变成故障。
    """
    assert installed.list_all(tmp_path / "nope") == []


def test_empty_dir_is_empty(tmp_path):
    assert installed.list_all(tmp_path) == []


# ── 不该出现在清单里的 ────────────────────────────────────────────────────────

def test_the_master_is_excluded(tmp_path):
    """母版就装在同一个父目录下，但它不是 cowork（需求 A8）。"""
    _install(tmp_path, "ipmaster")
    _install(tmp_path, MASTER_ID)
    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]


def test_dot_directories_are_skipped(tmp_path):
    (tmp_path / ".tmp-unpack").mkdir()
    _install(tmp_path, "ipmaster")
    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]


def test_loose_files_are_skipped(tmp_path):
    (tmp_path / "readme.txt").write_text("x", encoding="utf-8")
    _install(tmp_path, "ipmaster")
    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]


def test_a_directory_without_a_manifest_is_skipped(tmp_path):
    """解包到一半或手工放错——不当成一个 cowork。"""
    (tmp_path / "half").mkdir()
    _install(tmp_path, "ipmaster")
    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]


def test_id_must_match_the_directory_name(tmp_path):
    """**宁可跳过也不半信半疑地收下。**

    id 与目录名不一致时，按目录名找模板会落空。收下的表现是
    "这个 cowork 在列表里但建不了会话"，比不显示更难查（需求 F2）。
    """
    d = _install(tmp_path, "mbb")
    raw = json.loads((d / "cowork.json").read_text(encoding="utf-8"))
    raw["id"] = "something-else"
    (d / "cowork.json").write_text(json.dumps(raw), encoding="utf-8")

    assert installed.list_all(tmp_path) == []


def test_one_broken_manifest_does_not_empty_the_whole_list(tmp_path):
    """**这条最要紧。**

    一个坏文件让整份清单变空的话，用户看到的是"一个 cowork 都没有"——
    与"没权限"长得一模一样，会把配置问题误报成权限问题。
    """
    _install(tmp_path, "ipmaster")
    bad = tmp_path / "broken"
    bad.mkdir()
    (bad / "cowork.json").write_text("{ not json", encoding="utf-8")

    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]


# ── 版本与查询 ────────────────────────────────────────────────────────────────

def test_installed_versions(tmp_path):
    _install(tmp_path, "ipmaster", version="1.1.0")
    _install(tmp_path, "mbb", version="3")
    assert installed.versions(tmp_path) == {"ipmaster": "1.1.0", "mbb": "3"}


def test_installed_version_of_a_missing_one_is_none(tmp_path):
    assert installed.version_of(tmp_path, "nope") is None


def test_get_by_id(tmp_path):
    _install(tmp_path, "ipmaster")
    assert installed.get(tmp_path, "ipmaster").display_name == "IPMASTER"
    assert installed.get(tmp_path, "nope") is None


def test_is_installed_is_a_derivation_not_a_stored_flag(tmp_path):
    """**可用性是推导的，不写状态**（需求 I4）。

    删掉套件就不可用，放回去自动可用——中间没有任何需要迁移的标记。
    这正是"权限恢复后只读会话自己活过来"的基础。
    """
    import shutil

    d = _install(tmp_path, "mbb")
    assert installed.is_installed(tmp_path, "mbb") is True

    shutil.rmtree(d)
    assert installed.is_installed(tmp_path, "mbb") is False

    _install(tmp_path, "mbb")
    assert installed.is_installed(tmp_path, "mbb") is True, "装回来必须自动可用，不能要人清标记"
