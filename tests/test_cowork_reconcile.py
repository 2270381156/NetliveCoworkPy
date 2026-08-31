"""一次完整对账 —— 暂存目录 → 差集 → 装/删。

**这是唯一一处真的会改变本地状态的地方**，所以那几条"错了不可逆"的规则要在这里
端到端地验一遍，而不是只在各自的单元里验过就算。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.cowork import staging, installed
from netlivecowork.cowork.reconcile import reconcile
from netlivecowork.cowork.manifest import MASTER_ID
from tests.test_cowork_install import make_pkg


@pytest.fixture
def dirs(tmp_path):
    s, c = tmp_path / "staging", tmp_path / "coworks"
    s.mkdir(), c.mkdir()
    return s, c


def put(staging_dir, cid, version="1", **kw):
    staging.write_package(staging_dir, cid, version, make_pkg(cid, version, **kw))


def ids_on_disk(coworks_dir):
    """磁盘上装了哪几个。名字躲开 `installed` 模块。"""
    return sorted(c.id for c in installed.list_all(coworks_dir))


# ── 凭据的两种"空" ────────────────────────────────────────────────────────────

def test_no_credential_still_installs_but_never_removes(dirs):
    """**手工摆目录的开发态**：目录里有包，但没有凭据文件。

    此时**照装不误，但一个都不删** —— 这个不对称是有意的：

        装  可撤销（下次对账不在授权里就删掉了）
        删  **不可逆**，还会带走用户改过的提示词

    ⇒ 不知道"该有哪几个"时，往能恢复的那一侧偏。
    开发时往假云端目录里丢几个 zip 就能试，不必先伪造一份凭据。
    """
    s, c = dirs
    put(s, "a")
    r = reconcile(s, c)
    assert r.installed == {"a": "1"}, "开发态摆进去的包要能装上"
    assert r.removed == (), "但不知道该有哪几个时，一个都不能删"


def test_no_credential_never_removes_what_is_already_installed(dirs):
    """**这条是整组最要紧的。**

    "没拿到清单"与"拿到了一张空清单"必须区分。把网络故障当成权限被收回，
    后果是把用户的套件连同他改过的提示词删掉，**且不可逆**。
    """
    s, c = dirs
    put(s, "a")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)
    assert ids_on_disk(c) == ["a"]

    (s / staging.ENTITLED_FILE).unlink()          # 这次对账没成功
    r = reconcile(s, c)
    assert r.removed == ()
    assert ids_on_disk(c) == ["a"], "拿不到凭据时一个都不能删"


def test_an_explicitly_empty_credential_does_remove_everything(dirs):
    """反过来：**确实拿到了一张空清单**就该全删——那是"权限全被收回"。

    只做上一条会变成"永远不删"，权限收回就永远不生效。
    """
    s, c = dirs
    put(s, "a")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)

    staging.write_entitled(s, [])
    r = reconcile(s, c)
    assert r.removed == ("a",)
    assert ids_on_disk(c) == []


def test_a_corrupt_credential_file_counts_as_no_credential(dirs):
    """凭据文件坏了 = 不知道，**不是**"一个都没有"。"""
    s, c = dirs
    put(s, "a")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)

    (s / staging.ENTITLED_FILE).write_text("{ broken", encoding="utf-8")
    assert reconcile(s, c).removed == ()
    assert ids_on_disk(c) == ["a"]


# ── 装 ────────────────────────────────────────────────────────────────────────

def test_installs_what_is_entitled(dirs):
    s, c = dirs
    put(s, "a"), put(s, "b")
    staging.write_entitled(s, ["a", "b"])
    r = reconcile(s, c)
    assert r.installed == {"a": "1", "b": "1"}
    assert ids_on_disk(c) == ["a", "b"]


def test_a_package_present_but_not_entitled_is_not_installed(dirs):
    """开发机上堆着的包不能变成"人人都有全量"，否则权限就没意义了（需求 C13）。"""
    s, c = dirs
    put(s, "a"), put(s, "sneaky")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)
    assert ids_on_disk(c) == ["a"]


def test_same_version_is_skipped(dirs):
    s, c = dirs
    put(s, "a", "3")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)

    r = reconcile(s, c)
    assert r.installed == {} and r.skipped == {"a": "3"}


def test_a_rollback_to_a_smaller_version_is_installed(dirs):
    """**绝不能写成"变大才装"**（需求 C6）。

    云端下发的版本是递增整数，管理员回滚时它会变小。
    写成大于的现象是"我明明回滚了他还在用新版"，而且不报错。
    """
    s, c = dirs
    put(s, "a", "5")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)
    assert installed.version_of(c, "a") == "5"

    for f in s.glob("*.zip"):
        f.unlink()
    put(s, "a", "3")
    reconcile(s, c)
    assert installed.version_of(c, "a") == "3", "回滚必须装回去"


def test_entitled_but_the_package_never_arrived_is_not_a_removal(dirs):
    """**下载失败的不算被收回**（需求 C9）。

    它仍在凭据里，只是这次没取到包 —— 一次 403 不该等于替对方做了收回决定。
    """
    s, c = dirs
    put(s, "a")
    staging.write_entitled(s, ["a", "b"])       # b 在授权里但包没下下来
    r = reconcile(s, c)

    assert ids_on_disk(c) == ["a"]
    assert r.removed == (), "没取到包 ≠ 被收回"


def test_unchanged_ones_keep_their_place_even_without_a_zip(dirs):
    """**版本没变的不会重新下载，所以它的 zip 不在暂存目录里。**

    按"目录里有几个 zip"判凭据的话，这里就会把它当成被收回而删掉 ——
    这正是必须有一个独立凭据文件的根本原因（需求 C4）。
    """
    s, c = dirs
    put(s, "a"), put(s, "b")
    staging.write_entitled(s, ["a", "b"])
    reconcile(s, c)

    for f in s.glob("*.zip"):                    # 下一次对账：都没变，什么都没下
        f.unlink()
    staging.write_entitled(s, ["a", "b"])
    r = reconcile(s, c)

    assert r.removed == ()
    assert ids_on_disk(c) == ["a", "b"]


# ── 装与删同时 ────────────────────────────────────────────────────────────────

def test_install_and_revoke_in_one_pass(dirs):
    s, c = dirs
    put(s, "old")
    staging.write_entitled(s, ["old"])
    reconcile(s, c)

    for f in s.glob("*.zip"):
        f.unlink()
    put(s, "new")
    staging.write_entitled(s, ["new"])
    r = reconcile(s, c)

    assert r.installed == {"new": "1"} and r.removed == ("old",)
    assert ids_on_disk(c) == ["new"]


def test_the_master_survives_every_reconcile(dirs):
    """母版不是 cowork，没有谁的权限能收回它。

    删了的表现是一批老会话集体跑不动，而原因完全指不到这里。
    """
    s, c = dirs
    (c / MASTER_ID).mkdir(parents=True)
    (c / MASTER_ID / "SOUL.md").write_text("master", encoding="utf-8")
    staging.write_entitled(s, [])
    reconcile(s, c)
    assert (c / MASTER_ID).is_dir()


# ── 坏包 ──────────────────────────────────────────────────────────────────────

def test_one_bad_package_does_not_block_the_others(dirs):
    """一个坏包让全部都装不上的话，会把"某个包打错了"放大成"这个人一个都没有"，
    而那与"他没权限"长得一模一样。
    """
    s, c = dirs
    put(s, "good")
    (s / "broken.zip").write_bytes(b"not a zip")
    staging.write_entitled(s, ["good"])
    r = reconcile(s, c)

    assert ids_on_disk(c) == ["good"]
    assert "broken.zip" in r.failed


def test_an_unsigned_package_is_refused_end_to_end(dirs):
    """验签要真的挡在安装链路上，不是只在单元测试里成立。"""
    s, c = dirs
    (s / "a-1.zip").write_bytes(make_pkg("a", "1", sign=False))
    staging.write_entitled(s, ["a"])
    r = reconcile(s, c)

    assert ids_on_disk(c) == []
    assert any("签名" in v for v in r.failed.values())


# ── 日志：什么都没做也要留痕 ──────────────────────────────────────────────────

def test_doing_nothing_is_logged(dirs, caplog):
    """**"什么都没做"的分支必须留日志**（需求 K2）。

    `对账失败 → 一动不动` 与 `拿到空清单 → 全删` 在文件系统上是天壤之别，
    而在没有日志时它们看起来一模一样。
    """
    s, c = dirs
    with caplog.at_level("INFO"):
        reconcile(s, c)
    assert "没有授权凭据" in caplog.text


def test_skipping_because_the_version_matched_is_logged(dirs, caplog):
    """这是"改了内容却没改版本"时**唯一的线索**（需求 C7）。"""
    s, c = dirs
    put(s, "a", "1")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)

    with caplog.at_level("INFO"):
        reconcile(s, c)
    assert "版本相同已跳过" in caplog.text


def test_a_revocation_is_logged(dirs, caplog):
    """删除不可逆且会带走用户改过的提示词，**必须留痕**（需求 C4/K1）。"""
    s, c = dirs
    put(s, "a")
    staging.write_entitled(s, ["a"])
    reconcile(s, c)

    staging.write_entitled(s, [])
    with caplog.at_level("INFO"):
        reconcile(s, c)
    assert "权限收回" in caplog.text


# ── 凭据文件本身 ──────────────────────────────────────────────────────────────

def test_entitled_round_trip(tmp_path):
    staging.write_entitled(tmp_path, ["b", "a", "a"])
    assert staging.read_entitled(tmp_path) == frozenset({"a", "b"})


def test_entitled_file_has_a_timestamp(tmp_path):
    """写上时间是为了排查"这份凭据是什么时候的"——对账频率是每天一次，
    看时间就知道是不是卡在某一天没更新。
    """
    staging.write_entitled(tmp_path, ["a"])
    raw = json.loads((tmp_path / staging.ENTITLED_FILE).read_text(encoding="utf-8"))
    assert raw["syncedAt"]


def test_missing_entitled_file_is_none_not_empty(tmp_path):
    """**None 是"不知道"，空集合是"确实一个都没有"。** 搞混的代价不可逆。"""
    assert staging.read_entitled(tmp_path) is None
    staging.write_entitled(tmp_path, [])
    assert staging.read_entitled(tmp_path) == frozenset()
