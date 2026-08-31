"""host 文本回话分流（route_hitl_reply）测试 —— 把语义钉死防回归。

核心区分：
- approval：审批 = yes/no，按首词判定 approve/reject，其余文本作 message。
- question：整段文字即答复（"no" 是否定答复，不是"拒绝问题"）→ 一律 answer，绝不关键词拒绝。
"""

from __future__ import annotations

import pytest

from netlivecowork.api.schemas.sessions import route_hitl_reply

# ── approval：yes/no = approve/reject ────────────────────────────────────────────


@pytest.mark.parametrize("text,expected", [
    ("yes", ("approve", "")),
    ("approve", ("approve", "")),
    ("allow", ("approve", "")),
    ("yes, but be careful", ("approve", "but be careful")),   # 同意 + 备注
    ("looks fine to me", ("approve", "looks fine to me")),     # 非关键词首词 → 整段作备注
    ("no", ("reject", "")),
    ("reject", ("reject", "")),
    ("no, run ls first instead", ("reject", "run ls first instead")),  # 拒绝 + 指导
    ("拒绝", ("reject", "")),
])
def test_approval_routing(text, expected) -> None:
    assert route_hitl_reply("approval", text) == expected


# ── input：整段就是答复，"no" 也不例外 ─────────────────────────────────────────────


@pytest.mark.parametrize("text", [
    "use postgres",
    "no",                       # ← 关键：否定答复仍是答复，不能被路由成 reject
    "no, use the other one",
    "yes",
    "拒绝",
])
def test_input_always_answers(text) -> None:
    action, message = route_hitl_reply("question", text)
    assert action == "answer"
    assert message == text.strip()


def test_input_never_rejects_or_approves() -> None:
    # 任意 input 文本都不会落到 approve/reject
    for text in ("no", "reject", "deny", "yes", "approve", "随便什么"):
        action, _ = route_hitl_reply("question", text)
        assert action == "answer", f"input reply {text!r} must route to answer"


def test_whitespace_is_trimmed() -> None:
    assert route_hitl_reply("question", "  hello  ") == ("answer", "hello")
    assert route_hitl_reply("approval", "  yes  ") == ("approve", "")
