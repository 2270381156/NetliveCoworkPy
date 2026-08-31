"""模板从哪加载 —— **需求 F1 的落点**。

这是"装了哪几个既决定界面列什么、也决定实际能跑什么"的实处。
从出厂资源目录加载的话，没授权的 cowork 照样建得出会话 —— **权限就只剩展示了**。

⚠ 这块是本地实跑时才发现漏掉的：阶段 4 只做了能力隔离，模板仍从出厂目录加载，
于是套件装上了、界面也列出来了，一建会话就 500（模板找不到）。
接口 200 的那半好好的，坏的是另一半——所以补一组测试钉住它。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork.manifest import MASTER_ID


def test_templates_load_from_the_installed_suites_not_the_factory_dir(monkeypatch, tmp_path):
    """**装配必须把模板目录指向已装套件**（需求 F1）。

    指向出厂目录的话，那份是全量——没授权的 cowork 照样能建会话。
    """
    from netlivecowork import paths
    from netlivecowork.bootstrap import host_runtime

    coworks = tmp_path / "coworks"
    coworks.mkdir()
    monkeypatch.setattr(paths, "coworks_dir", lambda: coworks)

    import inspect
    src = inspect.getsource(host_runtime.build_host_runtime)
    assert "paths.coworks_dir()" in src, "模板目录要指向已装套件"
    assert "agents_dir = paths.agents_dir()" not in src, (
        "不能从出厂资源目录加载——那份是全量，权限会变成只剩展示"
    )


def test_the_master_is_seeded_into_the_suites_dir(tmp_path, monkeypatch):
    """母版要一起放进套件目录。

    它**不是 cowork**（列清单时按名字排除），但模板加载要用它：
    facet 兜底与"建会话未指定模板"的回落都靠它。
    不放进来的话，历史会话与内部任务会集体跑不动，而原因完全指不到这里。
    """
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _seed_master_template

    factory = tmp_path / "resources" / "agents" / MASTER_ID
    factory.mkdir(parents=True)
    (factory / "SOUL.md").write_text("master soul", encoding="utf-8")
    monkeypatch.setattr(paths, "resources_dir", lambda: tmp_path / "resources")

    coworks = tmp_path / "coworks"
    _seed_master_template(coworks)

    assert (coworks / MASTER_ID / "SOUL.md").read_text(encoding="utf-8") == "master soul"


def test_seeding_the_master_does_not_overwrite_an_existing_one(tmp_path, monkeypatch):
    """**只在缺了时才补**：覆盖会把用户改过的母版还原掉。"""
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _seed_master_template

    factory = tmp_path / "resources" / "agents" / MASTER_ID
    factory.mkdir(parents=True)
    (factory / "SOUL.md").write_text("factory", encoding="utf-8")
    monkeypatch.setattr(paths, "resources_dir", lambda: tmp_path / "resources")

    coworks = tmp_path / "coworks" / MASTER_ID
    coworks.mkdir(parents=True)
    (coworks / "SOUL.md").write_text("用户改过的", encoding="utf-8")

    _seed_master_template(tmp_path / "coworks")
    assert (coworks / "SOUL.md").read_text(encoding="utf-8") == "用户改过的"


def test_seeding_survives_a_missing_factory_master(tmp_path, monkeypatch):
    """出厂目录里没有母版（衍生品牌）时不该抛。"""
    from netlivecowork import paths
    from netlivecowork.bootstrap.host_runtime import _seed_master_template

    monkeypatch.setattr(paths, "resources_dir", lambda: tmp_path / "nope")
    _seed_master_template(tmp_path / "coworks")          # 不抛


def test_the_master_is_still_not_listed_as_a_cowork(tmp_path):
    """母版装在同一个目录下，但**永远不算一个 cowork**（需求 A8）。

    这条与上面几条合起来才完整：既要被模板加载扫到，又不能出现在阵容里。
    """
    from netlivecowork.cowork import installed

    for cid in (MASTER_ID, "ipmaster"):
        d = tmp_path / cid
        d.mkdir()
        (d / "cowork.json").write_text(
            json.dumps({"id": cid, "version": "1"}), encoding="utf-8")

    assert [c.id for c in installed.list_all(tmp_path)] == ["ipmaster"]
