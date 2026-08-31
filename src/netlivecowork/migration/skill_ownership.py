"""存量 skill 的归属判定 —— **一次性迁移规则，不是运行期回落**。

## 名单（需求 J10）

```
下列判为「通用」：docx · pptx · pdf · xlsx · skill-creator · skill-edit · huawei-intranet-search
其余一律归 ipmaster
```

## 为什么不能一律通用

存量装机里除了上面那几个文档处理与 skill 编辑工具，其余都是 IP 网络领域的东西
（拓扑绘图、L2VPN 拓扑、SDN 迁移调研）。判成通用会让它们出现在**所有** cowork 的
能力清单里 —— 模型手里多出一堆不该有的工具，而这正是本期要消灭的那种串台。

## 为什么不能一律归 ipmaster

那几个是所有 cowork 都要用的基础工具。判给 ipmaster 会让别的 cowork 连读个 docx 都不行，
而现象是"这个 agent 好像变笨了"，没人会联想到是导入时归属判错。

## ⚠ 一次性，不是回落

写成运行期兜底的话，用户事后改了归属会被下次启动重新覆盖回去（需求 J10.1）。
所以它只在导入那一刻跑一次，之后这份名单再不参与任何判断。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: 判为通用的那几个。**集中在这一处、可枚举、有测试**（需求 J10.1）。
GENERAL_SKILLS: frozenset[str] = frozenset({
    "docx",
    "pptx",
    "pdf",
    "xlsx",
    "skill-creator",
    "skill-edit",
    "huawei-intranet-search",
})

#: 其余归它。
DEFAULT_OWNER = "ipmaster"

#: 通配标签（与引用库那边同一个值）。
ANY_LABEL = "*"


def _normalize(name: str) -> str:
    """按 skill 名的既有规则归一：去空白、转小写。

    ⚠ 匹配不上的静默后果是"这个通用工具被判给了 ipmaster"，
    别的 cowork 里就少了它（需求 J10.3）。
    """
    return (name or "").strip().lower()


def labels_for(skill_name: str) -> tuple[str, ...]:
    """这个存量 skill 该归谁。

    ⚠ **与"当前有没有这个 cowork 的权限"无关**（需求 J10.2）：
    用户此刻没有 ipmaster 权限时，归属仍写 ipmaster，只是暂时不可见（不删）；
    权限到位后自动出现。**可见性是推导的，归属是数据** —— 两件事不能混。
    """
    return (ANY_LABEL,) if _normalize(skill_name) in GENERAL_SKILLS else (DEFAULT_OWNER,)


def assign(records: list[dict], *, name_key: str = "name") -> int:
    """给一批存量记录补上归属。返回改了几条。

    已经有归属的**不动** —— 这个函数可能被重复调到（导入重试），
    覆盖的话会把用户事后改过的归属抹掉。
    """
    changed = 0
    for r in records:
        if r.get("labels"):
            continue
        r["labels"] = list(labels_for(str(r.get(name_key) or "")))
        changed += 1
    if changed:
        logger.info("导入：为 %d 条存量 skill 记录补上归属", changed)
    return changed
