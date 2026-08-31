"""装与收回。

这一组分两半：
**校验**（什么样的包不许装进来）与**落盘**（装的时候不能留下半成品、删的时候不能多删）。

删这一侧尤其要紧：它**不可逆**，而且会连用户改过的提示词一起删（需求 C4）。
"""
from __future__ import annotations

import json
import zipfile
from io import BytesIO

import pytest

from netlivecowork.cowork import install, signature, installed
from netlivecowork.cowork.entitlement import Plan
from netlivecowork.cowork.manifest import MASTER_ID

FACETS = ("SOUL.md", "ROLE.md", "METADATA.md", "COMPACT.md")


def make_pkg(cid="ipmaster", version="1.0.0", *, sign=True, files=None, drop=(), extra=None):
    """造一个套件包。默认是合格的、已签名的。"""
    body = {f"{cid}/{f}": f"# {f}" for f in FACETS if f not in drop}
    body[f"{cid}/{install.MANIFEST_NAME}"] = json.dumps({"id": cid, "version": version})
    if files:
        body.update(files)
    if extra:
        body.update(extra)
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in body.items():
            zf.writestr(name, content)
    data = buf.getvalue()
    return signature.attach_signature(data) if sign else data


def write_pkg(d, cid="ipmaster", version="1.0.0", **kw):
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{cid}-{version}.zip"
    p.write_bytes(make_pkg(cid, version, **kw))
    return p


# ── 校验：什么样的包不许装 ────────────────────────────────────────────────────

def test_a_good_package_reports_its_id_and_version():
    assert install.inspect(make_pkg("mbb", "3")) == ("mbb", "3")


def test_not_a_zip_is_rejected():
    with pytest.raises(install.CoworkPackageError, match="ZIP"):
        install.inspect(b"not a zip at all")


def test_an_unsigned_package_is_rejected():
    """验签在最前——未经验证的内容不该被信任到"拿它的 id 决定装到哪"这一步。"""
    with pytest.raises(signature.SignatureError):
        install.inspect(make_pkg(sign=False))


def test_an_oversized_package_is_rejected():
    """装一份"不知道多大"的东西，磁盘可能被一个坏包吃光（需求 C14）。"""
    big = b"x" * (install.MAX_PACKAGE_BYTES + 1)
    with pytest.raises(install.CoworkPackageError, match="太大"):
        install.inspect(big)


def test_a_missing_facet_is_rejected():
    """**四个 facet 必须自带**（需求 A5/A6）。

    缺了运行期会被母版**静默补上**——装得上也跑得动，但用的是母版那份，
    而你以为是它自带的。⇒ 只能挡在装之前。
    """
    with pytest.raises(install.CoworkPackageError, match="facet"):
        install.inspect(make_pkg(drop=("ROLE.md",)))


def test_multiple_top_level_dirs_are_rejected():
    """顶层不唯一 ⇒ 解包后会散落多个条目，且无法判定这个包是谁。"""
    pkg = make_pkg(extra={"other/x.md": "x"})
    with pytest.raises(install.CoworkPackageError, match="顶层目录"):
        install.inspect(pkg)


def test_id_must_match_the_top_level_dir():
    """不一致的话装出来的目录名与它自称的 id 不同，后续按 id 找目录会落空。"""
    body = {f"ipmaster/{f}": "x" for f in FACETS}
    body["ipmaster/cowork.json"] = json.dumps({"id": "someone-else", "version": "1"})
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, c in body.items():
            zf.writestr(n, c)
    with pytest.raises(install.CoworkPackageError, match="不一致"):
        install.inspect(signature.attach_signature(buf.getvalue()))


def test_a_package_claiming_to_be_the_master_is_rejected():
    """母版不是 cowork，不能作为套件下发（需求 A8）。"""
    with pytest.raises(install.CoworkPackageError, match="母版"):
        install.inspect(make_pkg(MASTER_ID))


def test_a_manifest_without_version_is_rejected():
    body = {f"x/{f}": "x" for f in FACETS}
    body["x/cowork.json"] = json.dumps({"id": "x"})
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, c in body.items():
            zf.writestr(n, c)
    with pytest.raises(install.CoworkPackageError, match="version"):
        install.inspect(signature.attach_signature(buf.getvalue()))


# ── 扫目录 ────────────────────────────────────────────────────────────────────

def test_scan_reads_every_package(tmp_path):
    write_pkg(tmp_path, "a", "1")
    write_pkg(tmp_path, "b", "2")
    good, bad = install.scan(tmp_path)
    assert {k: v[0] for k, v in good.items()} == {"a": "1", "b": "2"}
    assert bad == {}


def test_scan_takes_the_newest_when_several_versions_pile_up(tmp_path):
    """**必须显式取最新**（需求 C2）。

    开发机上旧包会堆着。不显式取最新的话，装哪个取决于文件名排序——
    「1.9.0」排在「1.10.0」后面，于是装上旧版本，而现象只是"改了没生效"。
    """
    write_pkg(tmp_path, "a", "1.9.0")
    write_pkg(tmp_path, "a", "1.10.0")
    good, _ = install.scan(tmp_path)
    assert good["a"][0] == "1.10.0"


def test_one_bad_package_does_not_stop_the_others(tmp_path):
    """一个坏包让全部都装不上的话，会把"某个包打错了"放大成"这个人一个 cowork 都没有"，
    而那与"他没权限"长得一模一样。
    """
    write_pkg(tmp_path, "good", "1")
    (tmp_path / "broken.zip").write_bytes(b"garbage")
    good, bad = install.scan(tmp_path)
    assert list(good) == ["good"]
    assert "broken.zip" in bad


def test_scan_of_a_missing_dir_is_empty(tmp_path):
    """没配假云端目录 = 一个都没有，不是错误。"""
    assert install.scan(tmp_path / "nope") == ({}, {})


# ── 落盘 ──────────────────────────────────────────────────────────────────────

def test_apply_installs(tmp_path):
    pkgs, _ = install.scan(write_pkg(tmp_path / "pkgs", "a", "1").parent)
    target = tmp_path / "coworks"
    r = install.apply(Plan(install={"a": "1"}), pkgs, target)

    assert r.installed == {"a": "1"} and r.ok
    assert (target / "a" / "cowork.json").is_file()
    assert (target / "a" / "SOUL.md").is_file()
    assert [c.id for c in installed.list_all(target)] == ["a"]


def test_the_signature_entry_is_not_written_into_the_install_dir(tmp_path):
    """签名是包的元数据，不是 cowork 的内容——装出来的目录里不该有它。"""
    pkgs, _ = install.scan(write_pkg(tmp_path / "pkgs").parent)
    target = tmp_path / "coworks"
    install.apply(Plan(install={"ipmaster": "1.0.0"}), pkgs, target)
    assert not (target / "ipmaster" / signature.SIGNATURE_ENTRY).exists()
    assert not (target / signature.SIGNATURE_ENTRY).exists()


def test_reinstall_replaces_the_old_content(tmp_path):
    """换版本时旧文件要清掉——留着的话，上一版删掉的文件会在新版里"复活"。"""
    d = tmp_path / "pkgs"
    write_pkg(d, "a", "1", files={"a/extra.md": "old-only"})
    pkgs, _ = install.scan(d)
    target = tmp_path / "coworks"
    install.apply(Plan(install={"a": "1"}), pkgs, target)
    assert (target / "a" / "extra.md").is_file()

    for f in d.glob("*.zip"):
        f.unlink()
    write_pkg(d, "a", "2")
    pkgs2, _ = install.scan(d)
    install.apply(Plan(install={"a": "2"}), pkgs2, target)
    assert not (target / "a" / "extra.md").exists()


def test_path_traversal_is_blocked(tmp_path):
    """**zip 里的 `../` 会写到目标目录之外**（需求 E1）。

    判据用解析后的实际路径，不看字符串——`a/../../b` 这种字符串检查容易漏。
    """
    pkg = make_pkg("a", files={"a/../../escaped.md": "pwned"})
    target = tmp_path / "coworks"
    r = install.apply(Plan(install={"a": "1.0.0"}), {"a": ("1.0.0", pkg)}, target)

    assert r.failed, "带穿越路径的包必须装失败"
    assert not (tmp_path / "escaped.md").exists()
    assert not (tmp_path.parent / "escaped.md").exists()


def test_a_failed_install_does_not_leave_a_half_written_dir(tmp_path):
    """**先全部读出来再落盘。**

    解到一半失败会留下一个"装了一半"的目录，而那个目录看着是装好的
    （有清单、有部分文件），下次启动会被当成已装。
    """
    pkg = make_pkg("a", files={"a/../../escaped.md": "pwned"})
    target = tmp_path / "coworks"
    install.apply(Plan(install={"a": "1.0.0"}), {"a": ("1.0.0", pkg)}, target)
    assert not (target / "a").exists()


def test_a_planned_package_that_never_arrived_is_a_failure_not_a_removal(tmp_path):
    """计划里有、包却不在手上——**不算被收回**（需求 C9）。"""
    r = install.apply(Plan(install={"a": "1"}), {}, tmp_path / "coworks")
    assert "a" in r.failed and r.removed == ()


# ── 收回 ──────────────────────────────────────────────────────────────────────

def _installed(tmp_path, *ids):
    d = tmp_path / "coworks"
    for cid in ids:
        pkgs = {cid: ("1", make_pkg(cid, "1"))}
        install.apply(Plan(install={cid: "1"}), pkgs, d)
    return d


def test_removes_only_the_named_ones(tmp_path):
    d = _installed(tmp_path, "a", "b", "c")
    r = install.apply(Plan(remove=("b",)), {}, d)
    assert r.removed == ("b",)
    assert sorted(c.id for c in installed.list_all(d)) == ["a", "c"]


def test_removing_takes_user_edits_with_it(tmp_path):
    """**这一步不可逆**，且会连用户改过的提示词一起删（需求 C4）。

    钉住这个事实，是为了让"删除前必须显式告知用户"那条需求有据可依——
    实现的人看到这条测试就知道它不是危言耸听。
    """
    d = _installed(tmp_path, "a")
    (d / "a" / "SOUL.md").write_text("用户改过的提示词", encoding="utf-8")

    install.apply(Plan(remove=("a",)), {}, d)
    assert not (d / "a").exists()


def test_the_master_is_never_removed_even_if_named(tmp_path):
    """没有谁的权限能收回母版；删了的表现是一批老会话集体跑不动，
    而原因完全指不到这里。
    """
    d = _installed(tmp_path, "a")
    (d / MASTER_ID).mkdir(parents=True, exist_ok=True)
    (d / MASTER_ID / "SOUL.md").write_text("master", encoding="utf-8")

    install.apply(Plan(remove=(MASTER_ID, "a")), {}, d)
    assert (d / MASTER_ID).is_dir(), "母版永远保留"
    assert not (d / "a").exists()


def test_removing_something_not_installed_is_not_an_error(tmp_path):
    d = _installed(tmp_path, "a")
    r = install.apply(Plan(remove=("ghost",)), {}, d)
    assert r.removed == () and r.ok


def test_install_and_remove_in_one_apply(tmp_path):
    d = _installed(tmp_path, "old")
    pkgs = {"new": ("1", make_pkg("new", "1"))}
    r = install.apply(Plan(install={"new": "1"}, remove=("old",)), pkgs, d)

    assert r.installed == {"new": "1"} and r.removed == ("old",)
    assert [c.id for c in installed.list_all(d)] == ["new"]


def test_prune_to_keeps_what_it_is_told(tmp_path):
    """`prune_to` 是"保留这些"的写法，供已知完整清单时使用。"""
    d = _installed(tmp_path, "a", "b", "c")
    removed = install.prune_to(d, {"a"})
    assert sorted(removed) == ["b", "c"]
    assert [c.id for c in installed.list_all(d)] == ["a"]


def test_prune_to_never_touches_the_master(tmp_path):
    d = _installed(tmp_path, "a")
    (d / MASTER_ID).mkdir(parents=True, exist_ok=True)
    install.prune_to(d, set())
    assert (d / MASTER_ID).is_dir()
