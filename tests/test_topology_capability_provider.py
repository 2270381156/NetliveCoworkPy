"""TopologyCapabilityProvider：真实跑一遍 drawing-engine 的 Node 引擎（不 mock 子进程），
证明 Python <-> Node 这条 stdio 桥接真的能打通，不是只有类型对得上。"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ctx_weft.protocols.context import ProviderContext
from netlivecowork.providers.capability.topology import (
    TopologyCapabilityProvider,
    TopologyConfig,
)

ENGINE_DIR = Path(__file__).resolve().parents[1] / "drawing-engine"
SAMPLE_TOPOLOGY = json.loads((ENGINE_DIR / "sample-dual-core.topo.json").read_text(encoding="utf-8"))


@pytest.fixture
def provider() -> TopologyCapabilityProvider:
    return TopologyCapabilityProvider(TopologyConfig(engine_dir=ENGINE_DIR))


@pytest.fixture
def ctx() -> ProviderContext:
    return ProviderContext(session_id="test-session")


async def test_list_exposes_two_tools(provider, ctx) -> None:
    caps = await provider.list(ctx)
    assert {c.id for c in caps} == {"topology:draw_topology", "topology:export_diagram"}
    by_id = {c.id: c for c in caps}
    for c in caps:
        assert c.purposes == ["act"]
    # 两个都往磁盘写文件（draw 写预览 HTML、export 写成品），必须如实标 side_effects=True
    # ——调度层按这个位决定要不要确认/记账。原 observe/render 是纯计算标 False，
    # 2026-07-28 合并成 draw 后语义变了：它落盘。
    assert by_id["topology:draw_topology"].side_effects is True
    assert by_id["topology:export_diagram"].side_effects is True


async def test_describe(provider, ctx) -> None:
    info = await provider.describe(ctx)
    assert info.name == "topology"
    assert info.capability_count == 2


async def test_draw_topology_real_engine_returns_drc_report(provider, ctx, tmp_path) -> None:
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": SAMPLE_TOPOLOGY, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    kinds = [ev.kind for ev in events]
    assert "progress" in kinds
    assert kinds[-1] == "result"

    report = json.loads(events[-1].payload["content"])
    assert report["deviceCount"] == len(SAMPLE_TOPOLOGY["devices"])
    assert report["linkCount"] == len(SAMPLE_TOPOLOGY["links"])
    assert isinstance(report["findings"], list)
    # DRC 只查图纸本身（编码表/图例完整性、命名规范），不查网络工程设计（HA/冗余之类）——
    # 这份样例拓扑图纸层面本身是干净的（图例齐全、无重名），应该满分零发现。
    assert report["score"] == 100
    assert report["findings"] == []


async def test_draw_topology_real_engine_catches_drawing_defect(provider, ctx, tmp_path) -> None:
    """构造一份图纸层面有缺陷（用了编码表里没定义的 role）的模型，证明 DRC 规则库真的跑了，
    不是走了个空壳返回 100。"""
    broken = json.loads(json.dumps(SAMPLE_TOPOLOGY))  # deep copy
    broken["devices"][0]["role"] = "undefined-role"
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": broken, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    report = json.loads(events[-1].payload["content"])
    assert report["score"] < 100
    assert any(f["rule"] == "legend.role-missing" for f in report["findings"])


async def test_draw_topology_icon_fields_do_not_affect_drc(provider, ctx, tmp_path) -> None:
    """icon/iconTheme 是纯渲染信息,DRC 完全不检查——设了这两个字段的模型
    findings 应该跟不设时完全一样(这里用一份图例/命名都干净的模型验证零发现)。"""
    model = {
        "encoding": {
            "deviceRoles": {"core": {"legend": "核心交换机", "icon": "core-switch"}},
            "linkTypes": {"normal": {"legend": "链路"}},
            "connTypes": {},
        },
        "devices": [
            {"id": "A", "role": "core", "tier": 0, "label": "A", "iconTheme": "yellow"},
            {"id": "B", "role": "core", "tier": 1, "label": "B"},
        ],
        "links": [{"a": "A", "b": "B", "type": "normal"}],
    }
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": model, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    report = json.loads(events[-1].payload["content"])
    assert report["score"] == 100
    assert report["findings"] == []


async def test_draw_topology_duplicate_label_and_empty_legend_do_not_affect_drc(provider, ctx, tmp_path) -> None:
    """naming.duplicate-label / legend.*-empty 已经从 DRC 移除(合法的风格选择,不影响渲染
    正确性,不是缺陷)——构造一份两台设备同名 + 一条编码 legend 为空的模型,证明真实 DRC
    引擎(不是 mock)确实不再对这两种情况报警,拿满分零发现。"""
    model = {
        "encoding": {
            "deviceRoles": {"core": {"legend": ""}},
            "linkTypes": {"normal": {"legend": "链路"}},
            "connTypes": {},
        },
        "devices": [
            {"id": "A", "role": "core", "tier": 0, "label": "同名"},
            {"id": "B", "role": "core", "tier": 1, "label": "同名"},
        ],
        "links": [{"a": "A", "b": "B", "type": "normal"}],
    }
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": model, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    report = json.loads(events[-1].payload["content"])
    assert report["score"] == 100
    assert report["findings"] == []


async def test_draw_topology_writes_standalone_document(provider, ctx, tmp_path) -> None:
    """draw 落盘的 HTML 必须是"双击就能看到图"的自包含文档：图已经画好在 HTML 里，
    不依赖任何外部资源、也不靠浏览器现算。

    2026-07-25 起布局和绘制全部前移到 Node（见 2026-07-25-topology-geometry-in-node-*），
    HTML 里内嵌的是预渲染好的 SVG，浏览器只剩平移缩放——所以这里断言的是"有真实的图形
    内容"，而不是以前那条"内联了 topo.js 源码"（那条现在语义正好反过来，见下面的
    computeLayout 断言）。"""
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": SAMPLE_TOPOLOGY, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    kinds = [ev.kind for ev in events]
    assert "progress" in kinds
    assert kinds[-1] == "result"

    # draw 不回传 HTML 内容，只回传路径——2026-07-28 合并后的契约（原 render_html 把
    # 163KB 正文塞进返回值，触发 spill、逼 agent 用 shell 搬运文件、弹出权限审批）。
    result = json.loads(events[-1].payload["content"])
    assert set(result) >= {"path", "bytes", "score", "findings", "geometry", "style"}
    assert "html" not in result, "HTML 正文不该出现在返回值里"
    html = (tmp_path / "p.html").read_text(encoding="utf-8")
    assert html.startswith("<!DOCTYPE html>") or html.startswith("<!doctype html>")

    # ① 图是画好的，不是空壳：内嵌 SVG，且每台非装饰设备的 label 都是真实的 SVG 文本节点
    #    （只查 id 不够——id 会出现在溯源用的 window.TOPO 里，即使一根线都没画也能通过）。
    assert "<svg" in html
    roles = SAMPLE_TOPOLOGY["encoding"]["deviceRoles"]
    for device in SAMPLE_TOPOLOGY["devices"]:
        if roles.get(device["role"], {}).get("decorative"):
            continue  # 装饰节点（省略号）不出 label 文本
        assert f'>{device["label"]}<' in html, f"设备 {device['id']} 的 label 没画进 SVG"

    # ② 自包含：除 xmlns 命名空间外没有任何 http(s) 引用（图标是 base64 data URI）。
    externals = [u for u in re.findall(r"https?://[^\"'\s]+", html) if "www.w3.org" not in u]
    assert externals == [], f"HTML 引用了外部资源: {externals}"

    # ③ 浏览器端不再跑布局/绘制——这是本期的核心设计决定，反过来锁死，不让它悄悄回流。
    assert "computeLayout" not in html

    # ④ DRC 报告不是图纸的一部分，只通过 draw_topology 的返回值给 agent——落盘的 HTML
    #    不再内嵌 drc.js/runDRC（见 2026-07-09-legend-layer-participation.md），这是设计决定，
    #    不是回归；这条断言反过来锁定这个行为，不让它悄悄又被嵌回去。
    assert "runDRC" not in html
    # ⑤ window.TOPO 仍在，但只作溯源（这张图由哪份模型生成），不参与渲染。
    assert "window.TOPO" in html


async def test_draw_topology_model_without_meta_falls_back_to_default_title(provider, ctx, tmp_path) -> None:
    """meta 是可选字段（SOUL.md 从不要求 agent 写它），缺 meta 的模型必须照样渲染成功。

    历史上这是个真实的坑：render.js 的浏览器端脚本直接读 model.meta.name 不判空，缺 meta
    的模型加载即抛异常、整页画不出来。现在标题在 Node 侧算好写进 <title>，浏览器端根本
    不碰 meta，所以这里改成验证**行为**（渲染成功 + 落到默认标题"网络拓扑图"），而不是
    去断言某段防御性取值的写法——那段代码已经不存在了。"""
    model_without_meta = {k: v for k, v in SAMPLE_TOPOLOGY.items() if k != "meta"}
    assert "meta" not in model_without_meta

    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": model_without_meta, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert events[-1].kind == "result"

    html = (tmp_path / "p.html").read_text(encoding="utf-8")
    assert "<title>网络拓扑图</title>" in html
    # 图本身照样画出来了，不是"没崩但也是空白页"。
    assert f'>{SAMPLE_TOPOLOGY["devices"][0]["label"]}<' in html


async def test_export_diagram_writes_file_and_returns_only_path(provider, ctx, tmp_path) -> None:
    """export 的契约是"引擎落盘、只回路径"：二进制格式（PNG/PDF/vsdx）塞不进 stdout 的 JSON，
    base64 后经 agent 上下文更是灾难，所以 svg 这种文本格式也走同一条路径保持契约统一。
    这里用真实 Node 子进程跑一遍，并断言返回值里**没有**任何文件内容字段。
    routing 用 direct 是为了避开 elk 的 WASM 初始化，让这条用例快且稳定。"""
    out = tmp_path / "topo.svg"
    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"topology_json": SAMPLE_TOPOLOGY, "output_path": str(out), "routing": "direct"},
        ctx,
    )]
    kinds = [ev.kind for ev in events]
    assert "progress" in kinds
    assert kinds[-1] == "result", events[-1].payload

    result = json.loads(events[-1].payload["content"])
    assert result["path"] == str(out)
    assert result["format"] == "svg"
    assert isinstance(result["bytes"], int) and result["bytes"] > 0

    # 不回传文件内容——任何 svg/content/html/data 字段都是契约破坏。
    # warnings 是诊断信息（如"走线决定没回写 meta.routing"），不是文件内容，允许出现。
    assert set(result) == {"path", "bytes", "format", "warnings"}
    assert isinstance(result["warnings"], list)

    text = out.read_text(encoding="utf-8")
    assert text.startswith("<svg ")
    assert result["bytes"] == len(text.encode("utf-8"))


async def test_export_diagram_unsupported_format_yields_structured_error(provider, ctx, tmp_path) -> None:
    """png/pdf/vsdx 是后续版本的事，本期必须明确报错、不产出半成品文件。"""
    out = tmp_path / "topo.png"
    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"topology_json": SAMPLE_TOPOLOGY, "output_path": str(out), "format": "png"},
        ctx,
    )]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "UNSUPPORTED_FORMAT"
    assert not out.exists()


async def test_export_diagram_rejects_relative_output_path(provider, ctx) -> None:
    """相对路径必须当场拒掉，不能让文件落进引擎安装目录。

    真实 agent 踩过（2026-07-27）：它传了相对路径 campus-network.svg，工具返回成功、
    字节数也对，但文件写进了 resources/drawing-engine/ —— 用户在工作区里根本看不到，
    而应用安装目录被污染、下次升级就没了。子进程是用 cwd=engine_dir 起的（_run_node_cli），
    相对路径必然解析到那里去。
    """
    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"topology_json": SAMPLE_TOPOLOGY, "output_path": "relative-name.svg", "routing": "direct"},
        ctx,
    )]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "BAD_ARGS"
    assert "绝对路径" in events[-1].payload["message"]
    assert not (ENGINE_DIR / "relative-name.svg").exists()


async def test_export_diagram_warns_when_routing_not_persisted(provider, ctx, tmp_path) -> None:
    """routing 参数跟 meta.routing 不一致时必须给出 ROUTING_NOT_PERSISTED。

    走线方式是作者化决定：只有写进 meta.routing 才跟着模型走。真实 agent 按用户要求
    传 routing=direct 导出了直线图，却没回写 meta.routing——图是直线、模型说自己是正交，
    下次重新渲染会无声变回折线。SOUL.md 早写明"必须落到 meta.routing"，agent 被问到时
    也解释得很清楚，可见不是没看懂，而是没有信号在那一刻提醒它。
    """
    model = json.loads(json.dumps(SAMPLE_TOPOLOGY))
    model.setdefault("meta", {})["routing"] = "orthogonal"
    out = tmp_path / "topo.svg"

    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"topology_json": model, "output_path": str(out), "routing": "direct"},
        ctx,
    )]
    result = json.loads(events[-1].payload["content"])
    codes = [w["code"] for w in result["warnings"]]
    assert "ROUTING_NOT_PERSISTED" in codes, result["warnings"]

    # 两边一致时不该有噪音，否则 agent 会学会忽略这个字段
    model["meta"]["routing"] = "direct"
    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"topology_json": model, "output_path": str(out), "routing": "direct"},
        ctx,
    )]
    assert json.loads(events[-1].payload["content"])["warnings"] == []


async def test_draw_topology_invalid_model_yields_structured_error(provider, ctx, tmp_path) -> None:
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": {"meta": {}}, "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "INVALID_MODEL"


async def test_unknown_capability_yields_error(provider, ctx) -> None:
    events = [ev async for ev in provider.invoke("topology:bogus_tool", {}, ctx)]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "UNKNOWN_CAPABILITY"


# ── model_path：把模型从"工具参数"挪到"落盘文件" ────────────────────────────────
# 动机是硬约束而不是省流量：模型作为工具参数时必须由 LLM 逐字生成出来，受单次输出上限
# 约束——几十台设备展开成 JSON 就上万 token，根本传不进来；而生成它的脚本可能只有几十行。
# 走文件后那个大 JSON 完全不经过模型输出。


async def test_draw_topology_accepts_model_path(provider, ctx, tmp_path) -> None:
    """给文件路径应当和直接给字典产出同一张图——两条入口只是模型的来源不同。"""
    model_file = tmp_path / "m.topo.json"
    model_file.write_text(json.dumps(SAMPLE_TOPOLOGY), encoding="utf-8")

    by_path = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"model_path": str(model_file), "preview_path": str(tmp_path / "a.html")}, ctx,
    )]
    by_dict = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": SAMPLE_TOPOLOGY, "preview_path": str(tmp_path / "b.html")}, ctx,
    )]
    assert by_path[-1].kind == "result"
    a = json.loads(by_path[-1].payload["content"])
    b = json.loads(by_dict[-1].payload["content"])
    assert a["score"] == b["score"]
    assert a["bytes"] == b["bytes"]
    # 不只比字节数：两份 HTML 逐字节相同才能证明走的是同一条渲染路径
    assert (tmp_path / "a.html").read_bytes() == (tmp_path / "b.html").read_bytes()


async def test_draw_topology_strips_utf8_bom_in_model_file(provider, ctx, tmp_path) -> None:
    """带 BOM 的模型文件要能正常读。走 stdin 时碰不到（json.dumps().encode() 不产 BOM），
    但文件是别人写的——记事本、PowerShell 的 Out-File 默认都带 BOM，而 JSON.parse 见到
    U+FEFF 直接语法错，报出来是 "Unexpected token"，看不出真正原因。"""
    model_file = tmp_path / "bom.topo.json"
    model_file.write_bytes(b"\xef\xbb\xbf" + json.dumps(SAMPLE_TOPOLOGY).encode("utf-8"))

    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"model_path": str(model_file), "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert events[-1].kind == "result", events[-1].payload
    assert json.loads(events[-1].payload["content"])["score"] == 100


async def test_model_source_requires_exactly_one(provider, ctx, tmp_path) -> None:
    """两个都给或都不给都要报错。两个都收下就得定优先级，而任何优先级都会让另一个被
    静默忽略——调用方以为改了模型、实际画的是另一份，这类错误极难查。"""
    model_file = tmp_path / "m.topo.json"
    model_file.write_text(json.dumps(SAMPLE_TOPOLOGY), encoding="utf-8")

    both = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"topology_json": SAMPLE_TOPOLOGY, "model_path": str(model_file),
         "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert both[-1].kind == "error"
    assert both[-1].payload["code"] == "BAD_ARGS"
    assert "只能给一个" in both[-1].payload["message"]

    neither = [ev async for ev in provider.invoke(
        "topology:draw_topology", {"preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert neither[-1].kind == "error"
    assert neither[-1].payload["code"] == "BAD_ARGS"

    # 报错时不能留下半成品文件
    assert not (tmp_path / "p.html").exists()


async def test_model_path_must_be_absolute(provider, ctx, tmp_path) -> None:
    """相对路径会按引擎子进程的 cwd（引擎安装目录）解析，读到的不是调用方的文件。
    输出路径那条已经踩过一次（2026-07-27 文件写进了安装目录），输入侧同样要挡。"""
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"model_path": "m.topo.json", "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "BAD_ARGS"
    assert "绝对路径" in events[-1].payload["message"]


async def test_model_path_missing_file_reports_distinct_code(provider, ctx, tmp_path) -> None:
    """文件读不到和 JSON 语法错是两类问题，错误码要分开——糊成一个会让查错方向跑偏。"""
    events = [ev async for ev in provider.invoke(
        "topology:draw_topology",
        {"model_path": str(tmp_path / "nope.json"), "preview_path": str(tmp_path / "p.html")}, ctx,
    )]
    assert events[-1].kind == "error"
    assert events[-1].payload["code"] == "MODEL_FILE_UNREADABLE"


async def test_export_diagram_accepts_model_path(provider, ctx, tmp_path) -> None:
    """export 也要支持——刚 draw 完模型没变，再原样传一遍是纯浪费。"""
    model_file = tmp_path / "m.topo.json"
    model_file.write_text(json.dumps(SAMPLE_TOPOLOGY), encoding="utf-8")
    out = tmp_path / "out.svg"

    events = [ev async for ev in provider.invoke(
        "topology:export_diagram",
        {"model_path": str(model_file), "output_path": str(out), "format": "svg"}, ctx,
    )]
    assert events[-1].kind == "result", events[-1].payload
    assert out.exists() and out.stat().st_size > 0
