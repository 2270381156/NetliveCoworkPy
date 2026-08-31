"""搬什么、不搬什么 —— **选择性拷贝，不是整目录拷**（需求 J3）。

清单本身就是这块的核心知识：每一项"不搬"都对着一个具体的静默故障。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Action(str, Enum):
    COPY = "copy"          # 原样搬
    REWRITE = "rewrite"    # 搬，但内容要改（里面有指向旧目录的绝对路径）
    MERGE = "merge"        # 搬，但要与新版出厂的同名项合并
    SKIP = "skip"          # 不搬


@dataclass(frozen=True)
class Item:
    #: 相对数据目录的路径
    path: str
    action: Action
    #: 为什么。**"不搬"的理由尤其要写清楚** —— 每一条都对着一个静默故障。
    why: str


#: 导入清单（需求附录 B）。
PLAN: tuple[Item, ...] = (
    Item("data/ipmc-dev.db", Action.COPY,
         "会话历史，主体。⚠ 拷之前必须做 WAL 检查点，否则最近一段写入还在 WAL 里没落盘，"
         "拷过去就丢了——而现象是'最近几条会话不见了'，用户会以为是导入功能坏了"),
    Item("resources/llm_configs", Action.COPY, "LLM 账号与密钥"),
    Item("resources/mcp.json", Action.MERGE,
         "与新版出厂播种的同名项合并。直接覆盖会丢掉新版新增的随包 MCP；"
         "反过来直接跳过则丢掉用户自己加的"),
    Item("agents", Action.COPY, "用户自建的 agent"),
    Item("skills", Action.COPY, "用户导入的 skill"),
    Item("data/skill_references.json", Action.COPY,
         "skill 引用索引。⚠ 里面没有归属字段，导入时按固定名单判（见 skill_ownership）"),
    Item(".env", Action.REWRITE,
         "⚠ **必须重写**：里面是指向旧目录的绝对路径（数据目录、日志目录、资源目录）。"
         "照搬的结果是新版跑起来读写的还是旧目录——两个应用共用一份数据，"
         "问题会以极其难查的方式浮现"),
    Item("auth.bin", Action.COPY, "登录态。同一 Windows 用户下能解开"),
    Item("logs", Action.SKIP, "历史日志，一般不搬"),
    Item("data/venv", Action.SKIP,
         "依赖虚拟环境。里面写死了绝对路径，搬过去是坏的，必须由新版重建"),
    Item("install-id", Action.SKIP,
         "遥测安装 id。搬了两个安装共用同一个 id，遥测数据无法区分"),
    Item("installed-version", Action.SKIP,
         "安装版本标记。⚠ 搬了会让'这是第一次装吗'判错——而那正是导入引导的判据"),
    Item("last-version", Action.SKIP, "同上"),
    Item(".env-reconciled-version", Action.SKIP,
         "配置规整标记。搬了会跳过新版的 env reconcile"),
    Item(".bundled-seed-manifest.json", Action.SKIP,
         "随包播种标记。搬了新版会误判'已播种'，跳过出厂数据初始化"),
)

#: 那几个标记项：**搬了会让新版误判自己的状态**。单独列出来是为了让测试能钉住它们。
STATE_MARKERS: frozenset[str] = frozenset({
    "install-id", "installed-version", "last-version",
    ".env-reconciled-version", ".bundled-seed-manifest.json",
})


def items_to_copy() -> tuple[Item, ...]:
    return tuple(i for i in PLAN if i.action is not Action.SKIP)


def items_to_skip() -> tuple[Item, ...]:
    return tuple(i for i in PLAN if i.action is Action.SKIP)


def action_of(path: str) -> Action:
    for i in PLAN:
        if i.path == path:
            return i.action
    # 清单里没有的一律不搬。**白名单而不是黑名单**：
    # 黑名单漏一项就会把不该搬的搬过来，而那些正是会让新版误判状态的东西。
    return Action.SKIP
