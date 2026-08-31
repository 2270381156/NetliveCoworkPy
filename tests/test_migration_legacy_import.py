"""存量导入 —— 阶段 8。

三组：**归属名单**（那张固定表）、**导入清单**（搬什么不搬什么）、**闸门**（什么时候能导）。

清单里每一项"不搬"都对着一个具体的静默故障，所以测试逐条钉住它们——
搬错一项的后果不是报错，是新版误判自己的状态。
"""
from __future__ import annotations

import pytest

from netlivecowork.migration import gate, plan
from netlivecowork.migration.plan import Action
from netlivecowork.migration.skill_ownership import (
    ANY_LABEL,
    DEFAULT_OWNER,
    GENERAL_SKILLS,
    assign,
    labels_for,
)


# ── 归属名单 ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", sorted(GENERAL_SKILLS))
def test_the_general_tools_are_shared(name):
    """**那几个是所有 cowork 都要用的基础工具。**

    判给 ipmaster 会让别的 cowork 连读个 docx 都不行，
    而现象是"这个 agent 好像变笨了"，没人会联想到是导入时归属判错。
    """
    assert labels_for(name) == (ANY_LABEL,)


@pytest.mark.parametrize("name", [
    "huawei-l2vpn-topology", "sdn-migration-survey", "topology-drawing", "whatever-else",
])
def test_everything_else_goes_to_ipmaster(name):
    """**存量装机里其余都是 IP 网络领域的东西。**

    判成通用会让它们出现在所有 cowork 的能力清单里——模型手里多出一堆不该有的工具，
    而这正是本期要消灭的那种串台。
    """
    assert labels_for(name) == (DEFAULT_OWNER,)


def test_matching_ignores_case_and_whitespace():
    """⚠ 匹配不上的静默后果是"这个通用工具被判给了 ipmaster"，
    别的 cowork 里就少了它（需求 J10.3）。
    """
    assert labels_for("  DOCX  ") == (ANY_LABEL,)
    assert labels_for("Skill-Creator") == (ANY_LABEL,)


def test_an_empty_name_falls_to_the_default():
    assert labels_for("") == (DEFAULT_OWNER,)
    assert labels_for(None) == (DEFAULT_OWNER,)


def test_the_list_is_enumerable_and_pinned():
    """**名单集中在一处、可枚举、有测试**（需求 J10.1）。

    钉住内容是为了让"改动它"成为一个需要显式修改测试的动作，
    而不是随手加一行就悄悄改变了一批用户的归属。
    """
    assert GENERAL_SKILLS == frozenset({
        "docx", "pptx", "pdf", "xlsx",
        "skill-creator", "skill-edit", "huawei-intranet-search",
    })


def test_assign_fills_in_missing_labels():
    records = [{"name": "docx"}, {"name": "huawei-l2vpn-topology"}]
    assert assign(records) == 2
    assert records[0]["labels"] == ["*"]
    assert records[1]["labels"] == ["ipmaster"]


def test_assign_never_overwrites_an_existing_ownership():
    """**这是"一次性规则、不是运行期回落"的落点**（需求 J10.1）。

    覆盖的话，用户事后改的归属会被下次导入（或重试）抹掉。
    """
    records = [{"name": "docx", "labels": ["mbb"]}]
    assert assign(records) == 0
    assert records[0]["labels"] == ["mbb"]


def test_ownership_does_not_depend_on_current_permissions():
    """⚠ **归属按记录写，与当前有没有该权限无关**（需求 J10.2）。

    用户此刻没有 ipmaster 权限时，归属仍写 ipmaster，只是暂时不可见（不删）；
    权限到位后自动出现。**可见性是推导的，归属是数据** —— 两件事不能混。

    （这里能测的就是"它不去问权限"：函数签名里根本没有那个入口。）
    """
    import inspect

    assert list(inspect.signature(labels_for).parameters) == ["skill_name"]


# ── 导入清单 ──────────────────────────────────────────────────────────────────

def test_the_session_db_is_copied():
    assert plan.action_of("data/ipmc-dev.db") is Action.COPY


def test_the_wal_checkpoint_requirement_is_recorded():
    """不做检查点的话最近一段写入还在 WAL 里没落盘，拷过去就丢了（需求 J4）——
    而现象是"最近几条会话不见了"，用户会以为是导入功能坏了。
    """
    item = next(i for i in plan.PLAN if i.path == "data/ipmc-dev.db")
    assert "WAL" in item.why


def test_the_env_file_must_be_rewritten_not_copied():
    """**里面是指向旧目录的绝对路径**（需求 J5）。

    照搬的结果是新版跑起来读写的还是旧目录——两个应用共用一份数据，
    问题会以极其难查的方式浮现。
    """
    assert plan.action_of(".env") is Action.REWRITE


def test_mcp_config_is_merged_not_overwritten():
    """直接覆盖会丢掉新版新增的随包 MCP；反过来直接跳过则丢掉用户自己加的（需求 J8）。"""
    assert plan.action_of("resources/mcp.json") is Action.MERGE


def test_the_venv_is_not_copied():
    """里面写死了绝对路径，搬过去是坏的，必须由新版重建（需求 J6）。"""
    assert plan.action_of("data/venv") is Action.SKIP


@pytest.mark.parametrize("marker", sorted(plan.STATE_MARKERS))
def test_state_markers_are_never_copied(marker):
    """**搬了会让新版误判自己的状态**（需求 J7），而且每一种误判都不报错：

        遥测 id      两个安装共用一个，数据无法区分
        安装版本     "这是第一次装吗"判错——而那正是导入引导的判据
        配置规整标记 跳过新版的 env reconcile
        播种标记     误判"已播种"，跳过出厂数据初始化
    """
    assert plan.action_of(marker) is Action.SKIP


def test_unknown_paths_default_to_skip():
    """**白名单而不是黑名单。**

    黑名单漏一项就会把不该搬的搬过来，而那些正是会让新版误判状态的东西。
    """
    assert plan.action_of("something/nobody/thought/of") is Action.SKIP


def test_every_skipped_item_says_why():
    """"不搬"的理由必须写下来——否则下一个人会以为是漏了，顺手加回去。"""
    for item in plan.items_to_skip():
        assert item.why.strip(), f"{item.path} 没写为什么不搬"


def test_the_skill_reference_index_is_copied():
    assert plan.action_of("data/skill_references.json") is Action.COPY


# ── 闸门 ──────────────────────────────────────────────────────────────────────

def test_a_fresh_machine_is_a_first_run(tmp_path):
    assert gate.is_first_run(tmp_path) is True


def test_once_the_marker_exists_it_is_not_a_first_run(tmp_path):
    """⚠ **顺序是这条的全部难点**（需求 J13）。

    那个标记在首启播种的末尾就会被写出去，判定晚一步就永远判成"不是第一次"，
    而且不报错——用户再也看不到导入引导。
    """
    (tmp_path / gate.INSTALLED_MARKER).write_text("0.4.28", encoding="utf-8")
    assert gate.is_first_run(tmp_path) is False


def test_a_reinstall_is_not_a_first_run(tmp_path):
    """**卸载重装不算第一次**：卸载默认不删数据目录，标记还在。

    这是对的——数据还在，本来就不需要导入。
    """
    (tmp_path / gate.INSTALLED_MARKER).write_text("0.4.28", encoding="utf-8")
    assert gate.is_first_run(tmp_path) is False


def test_import_is_allowed_while_there_are_no_sessions(tmp_path):
    assert gate.can_import(tmp_path, own_session_count=0) is True


def test_import_is_refused_once_the_user_has_their_own_sessions(tmp_path):
    """**判据是"没有自己的会话"，不是"没用过"**（需求 J14）。

    会话正是会与导入数据冲突的东西。这条限定同时消掉了"合并还是覆盖"那个问题：
    新版必然是空的 ⇒ 不存在冲突（需求 J15）。
    """
    assert gate.can_import(tmp_path, own_session_count=1) is False


def test_import_is_refused_after_a_successful_import(tmp_path):
    """留标记，避免重复导入（需求 J9）。"""
    gate.mark_imported(tmp_path)
    assert gate.can_import(tmp_path, own_session_count=0) is False


def test_the_entry_stays_usable_after_declining_the_prompt(tmp_path):
    """**严格锁死在首启的话，用户点了"以后再说"就再也导不了了**（需求 J14）。

    ⇒ 主动弹用"首次"判，入口可用用推导判——两个判断分开。
    """
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    app = tmp_path / "app"
    app.mkdir()

    assert gate.should_prompt(app, legacy, own_session_count=0) is True

    # 首启过去了（标记写出来了），用户当时点了"以后再说"
    (app / gate.INSTALLED_MARKER).write_text("0.4.28", encoding="utf-8")
    assert gate.should_prompt(app, legacy, own_session_count=0) is False, "不再主动弹"
    assert gate.can_import(app, own_session_count=0) is True, "但入口仍然可用"


def test_no_prompt_without_legacy_data(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    assert gate.should_prompt(app, tmp_path / "nope", own_session_count=0) is False


def test_no_prompt_once_the_user_has_sessions(tmp_path):
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    app = tmp_path / "app"
    app.mkdir()
    assert gate.should_prompt(app, legacy, own_session_count=3) is False
