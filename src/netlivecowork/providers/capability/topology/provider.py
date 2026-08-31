"""TopologyCapabilityProvider —— 桥接 drawing-engine 的 Node 拓扑引擎。

给一份拓扑语义 JSON（devices/links/encoding[/zones]，不含任何坐标），拉起 Node 子进程
跑布局 + 走线 + 渲染 + 检查。两个工具对应两个时刻：
`draw_topology` 迭代期用——HTML 落盘给人看，同时返回诊断给 agent 看，一次调用服务两个受众；
`export_diagram` 确认后用——出成品（svg 矢量图 / vsdx 可编辑 Visio / pptx 汇报用；png/pdf 后续）。两者都只回传路径，不回传文件内容。
诊断部分是设计文档 §3 "observer 轮读 DRC 报告" 那个闭环点的实现。

DRC 只查"图纸本身"（编码表/图例完整性、id/label 命名规范），不检查网络工程设计好不好
（HA/冗余/单点故障之类）——这里画的是抽象拓扑，同一种网络结构有很多种同样合法的画法，
套一条"必须怎么连"的结构规则去检查，换个画法就文不对题。网络设计是否符合用户需求，
是 agent 自己对照需求做的语义判断，不是这层引擎的职责。

有意不做的事：不提供 write_topology 之类的编辑工具——拓扑 JSON 的读写复用已有的
fs:read_file / fs:write_file 即可（本方案的拓扑数据模型里从来没有坐标，Agent 直接写
整份 JSON 不存在"手改坐标"的风险，不需要 align/group 这类受限 Action API 来兜底）。
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import subprocess
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from ctx_weft.protocols.capability import (
    Capability,
    CapabilityEvent,
    CapabilityProviderInfo,
    ToolCapabilityProvider,
)
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.providers._tooldecl import make_tool_registry

logger = logging.getLogger(__name__)

PROVIDER_NAME = "topology"

tool, _TOPOLOGY_TOOLS, _TOPOLOGY_IMPLS = make_tool_registry(PROVIDER_NAME)

_DEFAULT_CLI_TIMEOUT_SEC = 15


class NodeCliError(Exception):
    """cli.js 侧报的结构化错误（或桥接本身失败：超时/非 JSON 输出）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


@dataclass
class TopologyConfig:
    """Provider 运行时配置。"""

    # drawing-engine/ 目录整体（入口是 cli.js，其余模块与 node_modules 都要在同一目录下；
    # 缺省 routing=orthogonal 会动态 import geometry-elk.mjs，依赖 node_modules 里的
    # elkjs + @mr_mint/elkjs-libavoid。别再在注释或打包脚本里列"含哪几个文件"——
    # 那份手工清单正是 2026-07-25 修掉的打包缺陷。）
    engine_dir: Path
    node_executable: str = "node"
    cli_timeout_sec: int = _DEFAULT_CLI_TIMEOUT_SEC


# 子进程不需要控制台，故禁建窗口。非 Windows 无此常量 → 0（POSIX 忽略 creationflags）。
# node.exe 是**控制台子系统**程序，而打包后的宿主是 GUI 进程（没有控制台可继承）。
# 不传这个 flag 时 Windows 会给它新建一个控制台窗口——用户实测每次画图都闪一下黑框。
# 每轮迭代都要调一次 draw_topology，所以是高频可见的干扰，不是偶发。
# 这不是新发明的做法：ctx_weft 的 _grep.py / _venv.py / _script_runner.py 三处都这么写，
# Electron 侧起后端与 powershell 也一律 windowsHide: true——只有这个 provider 漏了。
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


async def _run_node_cli(
    cfg: TopologyConfig,
    subcommand: str,
    payload: dict[str, Any],
    extra_args: list[str] | None = None,
) -> dict[str, Any]:
    """拉起 `node cli.js <subcommand> [extra_args…]`，走 stdin 喂 JSON、stdout 收 JSON。"""
    argv = [cfg.node_executable, str(cfg.engine_dir / "cli.js"), subcommand, *(extra_args or [])]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cfg.engine_dir),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(json.dumps(payload).encode("utf-8")),
            timeout=cfg.cli_timeout_sec,
        )
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise NodeCliError("TIMEOUT", f"node cli.js {subcommand} 超时 ({cfg.cli_timeout_sec}s)") from None

    try:
        result = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError:
        raise NodeCliError(
            "BAD_OUTPUT",
            f"node cli.js 输出不是合法 JSON (exit={proc.returncode}): "
            f"{stderr.decode('utf-8', 'replace')[:500]}",
        ) from None

    if isinstance(result, dict) and result.get("error"):
        raise NodeCliError(str(result["error"]), str(result.get("message", "")))
    return result


def _model_source(
    topology_json: dict | None, model_path: str | None
) -> tuple[dict, list[str]] | str:
    """把两种模型入参归一成 (喂给 stdin 的 payload, 追加的 argv)。返回 str 表示参数有错。

    两者**必须且只能给一个**。两个都收下的话就要定优先级，而任何优先级规则都会让另一个
    被静默忽略——调用方以为改了模型，实际画的是另一份，这类错误查起来极其费劲。
    宁可直接报错。
    """
    if topology_json is not None and model_path is not None:
        return "topology_json 和 model_path 只能给一个：同时给会有一个被忽略，而你无法从结果看出用的是哪份。"
    if topology_json is None and model_path is None:
        return "必须给 topology_json（直接给模型字典）或 model_path（已落盘的 .topo.json 绝对路径）之一。"
    if model_path is not None:
        # 绝对路径在这里先挡一道。CLI 侧也有同样的校验（那是引擎自己的护栏），但在这里挡
        # 能少起一个子进程，报错也更贴近调用方看到的参数名。
        if not os.path.isabs(model_path):
            return f'model_path 必须是绝对路径，收到 "{model_path}"。相对路径会解析到引擎安装目录，读不到你的文件。'
        return ({}, [f"--model={model_path}"])
    return (topology_json, [])


@tool(purposes=["act"], side_effects=True)
async def draw_topology(
    preview_path: Annotated[str, "预览 HTML 的输出路径，必须是绝对路径，扩展名 .html"],
    topology_json: Annotated[
        dict | None, "拓扑语义模型（devices/links/encoding[/zones]），不含任何坐标。与 model_path 二选一"
    ] = None,
    model_path: Annotated[
        str | None,
        "已落盘的 .topo.json 绝对路径。与 topology_json 二选一。"
        "设备多时优先用它：写脚本生成文件，模型 JSON 就不必逐字打进工具参数",
    ] = None,
    routing: Annotated[str, "走线方式：当前仅支持 direct（两点直线）；orthogonal 正交折线暂未开放"] = "direct",
    *,
    ctx: ProviderContext | None = None,
) -> AsyncIterator[CapabilityEvent]:
    """画出当前拓扑并同时返回诊断——迭代期就用这一个工具。

    做两件事：把单文件离线 HTML 写到 preview_path（用户在预览面板里看这张图），
    同时返回结构化诊断给你（DRC 0-100 分 + findings + geometry 几何测量 + style 图示体检）。
    **不返回 HTML 内容本身**，只返回路径和字节数——不要试图读回文件内容再转存。

    每改一轮模型就调一次：用户看到最新的图，你拿到最新的诊断，两者同源。
    分数低说明图纸本身（编码表/图例完整性、id/label 命名）有问题——这**不**是网络工程设计
    质量评分，不检查 HA/冗余/单点故障之类。网络设计是否符合用户需求，对照用户原始描述自行
    判断，不要用这个分数当替代品。

    模型两种给法，**必须且只能给一种**：
    - `topology_json`：直接给字典。图不大时最省事。
    - `model_path`：给已落盘的 .topo.json 绝对路径。**设备多的时候用这个**——工具参数
      里的模型要你逐字生成出来，受单次输出上限约束；几十台设备展开成 JSON 就上万 token
      了，而生成它的脚本可能只有几十行。先用 shell 写脚本产出文件，再把路径给这里。

    路径参数一律要绝对路径：引擎子进程的工作目录是引擎自己的安装目录，相对路径会解析到
    那里去——输出文件用户找不到，输入文件读不着。
    """
    if ctx is None or "topology_config" not in ctx.extra:
        yield CapabilityEvent(
            kind="error",
            payload={"code": "NOT_CONFIGURED", "message": "topology provider 未正确注入 TopologyConfig"},
        )
        return
    cfg: TopologyConfig = ctx.extra["topology_config"]

    src = _model_source(topology_json, model_path)
    if isinstance(src, str):
        yield CapabilityEvent(kind="error", payload={"code": "BAD_ARGS", "message": src})
        return
    payload, model_args = src

    yield CapabilityEvent(kind="progress", payload={"status": "drawing"})
    try:
        result = await _run_node_cli(
            cfg, "draw", payload,
            extra_args=[f"--out={preview_path}", f"--routing={routing}", *model_args],
        )
    except NodeCliError as e:
        yield CapabilityEvent(kind="error", payload={"code": e.code, "message": e.message})
        return

    yield CapabilityEvent(kind="result", payload={"content": json.dumps(result, ensure_ascii=False)})


@tool(purposes=["act"], side_effects=True)
async def export_diagram(
    output_path: Annotated[str, "导出文件的完整路径，扩展名要跟 format 一致"],
    topology_json: Annotated[
        dict | None, "拓扑语义模型（devices/links/encoding[/zones]），不含任何坐标。与 model_path 二选一"
    ] = None,
    model_path: Annotated[
        str | None,
        "已落盘的 .topo.json 绝对路径。与 topology_json 二选一。"
        "刚 draw 过同一份模型时优先用它——同样的模型再逐字传一遍纯属浪费",
    ] = None,
    format: Annotated[str, "导出格式：svg（矢量图，看图/嵌文档）"
                        " / vsdx（Visio/亿图里继续编辑）"
                        " / pptx（塞进汇报材料，用 PowerPoint 直接改；固定 16:9，图等比缩放居中，当前不含图例）"
                        "；png/pdf 暂未实现"] = "svg",
    routing: Annotated[str, "走线方式：当前仅支持 direct（两点直线）；orthogonal 正交折线暂未开放"] = "direct",
    *,
    ctx: ProviderContext | None = None,
) -> AsyncIterator[CapabilityEvent]:
    """把拓扑导出成文件，由引擎直接落盘，只返回路径和字节数——**不返回文件内容**。

    跟 draw_topology 的区别：draw 是迭代期出预览 HTML + 拿诊断，本工具是确认后出交付成品，
    不返回诊断。导出成功后把 output_path 告诉用户即可，不要试图读回文件内容。

    模型两种给法，**必须且只能给一种**：`topology_json`（直接给字典）或 `model_path`
    （已落盘的 .topo.json 绝对路径）。模型没变的话给路径——刚画完又原样传一遍模型是纯浪费。
    """
    if ctx is None or "topology_config" not in ctx.extra:
        yield CapabilityEvent(
            kind="error",
            payload={"code": "NOT_CONFIGURED", "message": "topology provider 未正确注入 TopologyConfig"},
        )
        return
    cfg: TopologyConfig = ctx.extra["topology_config"]

    src = _model_source(topology_json, model_path)
    if isinstance(src, str):
        yield CapabilityEvent(kind="error", payload={"code": "BAD_ARGS", "message": src})
        return
    payload, model_args = src

    yield CapabilityEvent(kind="progress", payload={"status": "exporting"})
    try:
        result = await _run_node_cli(
            cfg, "export", payload,
            extra_args=[f"--format={format}", f"--out={output_path}", f"--routing={routing}", *model_args],
        )
    except NodeCliError as e:
        yield CapabilityEvent(kind="error", payload={"code": e.code, "message": e.message})
        return

    yield CapabilityEvent(kind="result", payload={"content": json.dumps(result, ensure_ascii=False)})


class TopologyCapabilityProvider(ToolCapabilityProvider):
    """桥接 drawing-engine Node 引擎的 capability provider。无状态：每次调用起一个子进程。"""

    name = PROVIDER_NAME
    description = "网络拓扑图纸规范性诊断——给一份拓扑语义 JSON，跑布局+图纸检查引擎，返回结构化诊断（不检查网络工程设计）。"

    def __init__(self, config: TopologyConfig) -> None:
        self._cfg = config
        self._invokers = {
            tool_name: (lambda f: lambda args, ctx: f(**args, ctx=ctx))(fn)
            for tool_name, fn in _TOPOLOGY_IMPLS.items()
        }

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        return list(_TOPOLOGY_TOOLS.values())

    def invoke(
        self,
        capability_id: str,
        arguments: dict[str, Any],
        ctx: ProviderContext,
    ) -> AsyncIterator[CapabilityEvent]:
        extra = dict(ctx.extra)
        extra["topology_config"] = self._cfg
        ctx = dataclasses.replace(ctx, extra=extra)
        return self._dispatch(capability_id, arguments, ctx)

    async def _dispatch(
        self,
        capability_id: str,
        arguments: dict[str, Any],
        ctx: ProviderContext,
    ) -> AsyncIterator[CapabilityEvent]:
        tool_name = capability_id.split(":")[-1]
        invoker = self._invokers.get(tool_name)
        if invoker is None:
            yield CapabilityEvent(
                kind="error",
                payload={"code": "UNKNOWN_CAPABILITY", "message": f"Unknown: {capability_id}"},
            )
            return
        async for ev in invoker(arguments, ctx):
            yield ev

    async def cancel(self, invocation_id: str, ctx: ProviderContext) -> None:
        pass  # 无状态、每次调用独立子进程，进程本身随 asyncio.wait_for 超时/取消一起收掉

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        return CapabilityProviderInfo(
            name=self.name,
            capability_count=len(_TOPOLOGY_TOOLS),
            supports_streaming=True,
            supports_cancel=False,
            description=self.description,
        )
