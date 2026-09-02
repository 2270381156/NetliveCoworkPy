"""套件清单的运行期解析。

运行期解析的原则与构建期校验**相反**：这里面对的是"已经装上的东西"，
容忍缺字段而不是拒绝启动——装都装上了才发现清单少个字段，
此时拒绝启动的代价远大于按缺省值继续。

所以这里的用例大多在问："这个字段坏了/缺了，会不会把整份清单带塌"。
"""
from __future__ import annotations

import json

from netlivecowork.cowork.manifest import (
    DEFAULT_ORDER,
    MAX_SKILL_PRESETS,
    MASTER_ID,
    Cowork,
    SkillPreset,
    bare_id,
)
from netlivecowork.cowork.manifest_parse import parse, read


def _raw(**over):
    base = {
        "schema": 1,
        "id": "ipmaster",
        "version": "1.1.0",
        "order": 10,
        "branding": {"displayName": "IPMaster Cowork", "subtitle": "IP 网络", "accent": "#3b82f6"},
        "mcp": {"use": ["tech-kb", "browser-mcp"], "define": {"tech-kb": {"url": "https://kb/mcp"}}},
        "llm": {"allow": ["DS", "HIS"]},
        "skills": {"pullServerUrl": "https://m/api", "mythosBaseUrl": "https://y"},
    }
    base.update(over)
    return base


# ── 正常路径 ──────────────────────────────────────────────────────────────────

def test_parses_every_declared_field():
    c = parse(_raw())
    assert c is not None
    assert (c.id, c.version, c.order) == ("ipmaster", "1.1.0", 10)
    assert c.display_name == "IPMaster Cowork" and c.subtitle == "IP 网络"
    assert c.mcp_use == ("tech-kb", "browser-mcp")
    assert c.llm_allow == ("DS", "HIS")
    assert c.skill_market_url == "https://m/api" and c.skill_mythos_url == "https://y"
    assert [d.name for d in c.mcp_define] == ["tech-kb"]
    assert c.mcp_define[0].config == {"url": "https://kb/mcp"}


def test_template_id_and_bare_id_round_trip():
    """**转换点只有一处，逆向必须对得上。**

    实测教训：可用性校验忘了剥前缀，四个 cowork 全被拒，
    而错误信息说的是"未安装或你没有权限"——一个前缀 bug 被伪装成了权限问题。
    """
    c = parse(_raw())
    assert c.template_id == "agent:ipmaster"
    assert bare_id(c.template_id) == c.id


def test_bare_id_is_idempotent():
    """给了裸 id 也照样返回裸 id——调用方不必先判断"这个带没带前缀"。"""
    assert bare_id("ipmaster") == "ipmaster"
    assert bare_id("agent:ipmaster") == "ipmaster"
    assert bare_id("") == ""


# ── 认不出来的（返回 None，不抛）────────────────────────────────────────────────

def test_non_object_is_not_a_cowork():
    assert parse([1, 2, 3]) is None
    assert parse("hello") is None
    assert parse(None) is None


def test_missing_id_is_not_a_cowork():
    assert parse(_raw(id="")) is None
    assert parse({"version": "1.0.0"}) is None


def test_the_master_is_never_a_cowork():
    """母版参与模板继承，但**不是 cowork**：不下发、不进阵容、不能建会话（需求 A8）。

    它就装在同一个父目录下，所以每一处列举都必须把它排除掉。
    """
    assert parse(_raw(id=MASTER_ID)) is None


# ── 缺字段：按缺省值继续，不拒绝 ──────────────────────────────────────────────

def test_missing_optional_sections_fall_back():
    c = parse({"id": "mbb", "version": "1.0.0"})
    assert c is not None
    assert c.display_name == "mbb", "没有品牌名就用 id，不能显示成空白"
    assert c.mcp_use == () and c.llm_allow == ()
    assert c.skill_market_url == "" and c.mcp_define == ()


def test_sections_of_the_wrong_type_are_ignored_not_fatal():
    """某一段写成了字符串/数组——只丢那一段，不丢整份。"""
    c = parse(_raw(mcp="oops", llm=[], skills=123, branding=None))
    assert c is not None and c.id == "ipmaster"
    assert c.mcp_use == () and c.llm_allow == ()


def test_missing_order_sorts_last_but_still_shows():
    """没写次序的排最后，**但仍然显示**——不显示的话用户会以为套件没装上。"""
    assert parse(_raw(order=None)).order == DEFAULT_ORDER
    c = _raw()
    del c["order"]
    assert parse(c).order == DEFAULT_ORDER


def test_boolean_order_is_rejected():
    """**bool 是 int 的子类**：`order: true` 不挡的话会被当成 1，
    成为一个悄悄排到最前的 cowork，而没人会察觉这是个错误（需求 A6）。
    """
    assert parse(_raw(order=True)).order == DEFAULT_ORDER
    assert parse(_raw(order=False)).order == DEFAULT_ORDER


def test_non_integer_order_falls_back():
    assert parse(_raw(order="10")).order == DEFAULT_ORDER
    assert parse(_raw(order=1.5)).order == DEFAULT_ORDER


def test_order_zero_and_negative_are_honoured():
    """0 和负数是合法次序，别被"假值"判断吃掉。"""
    assert parse(_raw(order=0)).order == 0
    assert parse(_raw(order=-5)).order == -5


# ── 列表与定义的清洗 ──────────────────────────────────────────────────────────

def test_list_entries_are_trimmed_and_blanks_dropped():
    c = parse(_raw(mcp={"use": ["  a  ", "", "   ", "b"]}))
    assert c.mcp_use == ("a", "b")


def test_a_non_list_use_is_not_split_into_characters():
    """写成字符串时不能被当成可迭代对象拆成一串单字。"""
    c = parse(_raw(mcp={"use": "abc"}))
    assert c.mcp_use == ()


def test_mcp_define_keeps_the_raw_config_shape():
    """连接定义原样带过去，**不在这里定义第二套字段**。

    两套形状迟早漂移，而漂移的表现是"同一个 server 从套件下发就连不上、
    手工写进 mcp.json 就能连"。
    """
    cfg = {"command": "node", "args": ["x.js"], "env": {"K": "V"}}
    c = parse(_raw(mcp={"define": {"local": cfg}}))
    assert c.mcp_define[0].config == cfg


def test_mcp_define_entries_that_are_not_objects_are_skipped():
    c = parse(_raw(mcp={"define": {"good": {"url": "u"}, "bad": "not-a-dict"}}))
    assert [d.name for d in c.mcp_define] == ["good"]


# ── skills.presets：profile 预置的 skill 引用 ─────────────────────────────────

def test_manifest_parses_skill_presets():
    """完整 L1 元数据原样进模型：预置协调全靠这份元数据，启动时不访问市场。"""
    c = parse(_raw(skills={
        "pullServerUrl": "https://cowork",
        "presets": [{
            "source": "mythos",
            "remoteId": "1129",
            "name": "调用量上报",
            "description": "上报调用量",
            "version": "1.0",
            "triggers": ["调用量", "上报"],
        }],
    }))
    assert c is not None
    assert c.skill_presets == (SkillPreset(
        source="mythos",
        remote_id="1129",
        name="调用量上报",
        description="上报调用量",
        version="1.0",
        triggers=("调用量", "上报"),
    ),)


def test_manifest_skips_invalid_and_duplicate_skill_presets(caplog):
    """坏的那一条跳过，不连累其余；重复身份只留第一条。"""
    c = parse(_raw(skills={"presets": [
        {"source": "cowork", "remoteId": "1", "name": "A", "description": "d"},
        {"source": "cowork", "remoteId": "1", "name": "duplicate", "description": "d"},
        {"source": "", "remoteId": "2", "name": "bad", "description": "d"},
        "not-an-object",
    ]}))
    assert [(p.source, p.remote_id) for p in c.skill_presets] == [("cowork", "1")]
    assert "preset" in caplog.text.lower()


def test_manifest_limits_skill_preset_count_and_metadata(caplog):
    """超上限的条目跳过：数量与长度上限是契约，发布侧按同一套严格拒绝。"""
    with caplog.at_level("WARNING"):
        c = parse(_raw(skills={"presets": [
            # name 超长（上限 200）→ 整条跳过
            {"source": "cowork", "remoteId": "1", "name": "x" * 201, "description": "d"},
            # 单个 trigger 超长（上限 256）→ 整条跳过
            {"source": "cowork", "remoteId": "2", "name": "B", "description": "d",
             "triggers": ["y" * 257]},
            # name 恰好压线 200 → 保留
            {"source": "cowork", "remoteId": "3", "name": "z" * 200, "description": "d"},
        ]}))
    assert [p.remote_id for p in c.skill_presets] == ["3"]

    many = [{"source": "cowork", "remoteId": str(i), "name": f"n{i}", "description": "d"}
            for i in range(MAX_SKILL_PRESETS + 5)]
    c2 = parse(_raw(skills={"presets": many}))
    assert len(c2.skill_presets) == MAX_SKILL_PRESETS


def test_skill_presets_default_to_empty_and_tolerate_wrong_type():
    """没写 presets、或写成非列表，都当没有预置，不影响其余字段。"""
    c = parse(_raw(skills={"pullServerUrl": "https://m/api"}))
    assert c is not None and c.skill_presets == ()
    c2 = parse(_raw(skills={"presets": "oops"}))
    assert c2 is not None and c2.skill_presets == () and c2.skill_market_url == ""


# ── 空语义：MCP 与 LLM 刻意相反 ───────────────────────────────────────────────

def test_empty_mcp_and_empty_llm_mean_opposite_things():
    """**这条差异务必保留**（需求 G12）。

    MCP 是能力，"明确给了才有"；LLM 是资源选择，"没说就是都能用"。
    统一成一种的话：要么所有 cowork 都没模型可用，要么 MCP 权限形同虚设。
    这里只钉住解析结果都是空元组，语义差别由使用方各自实现——
    但两边的注释必须写明，否则下一个人会来"统一"它。
    """
    c = parse({"id": "x", "version": "1"})
    assert c.mcp_use == () and c.llm_allow == ()


# ── 从文件读 ──────────────────────────────────────────────────────────────────

def test_read_from_file(tmp_path):
    p = tmp_path / "cowork.json"
    p.write_text(json.dumps(_raw(), ensure_ascii=False), encoding="utf-8")
    assert read(p).id == "ipmaster"


def test_a_broken_file_returns_none_instead_of_raising(tmp_path):
    """**单个坏清单只丢它自己。**

    让一个坏文件把整份清单变空，用户看到的是"一个 cowork 都没有"——
    而那与"没权限"长得一模一样，会把配置问题误报成权限问题。
    """
    p = tmp_path / "cowork.json"
    p.write_text("{ not json", encoding="utf-8")
    assert read(p) is None


def test_a_missing_file_returns_none(tmp_path):
    assert read(tmp_path / "nope.json") is None


def test_frozen_model_cannot_be_mutated_by_accident():
    """清单是只读快照。可变的话，某处顺手改一下会影响到别处的判断。"""
    import dataclasses

    c = parse(_raw())
    try:
        c.id = "other"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("Cowork 应当是只读的")
