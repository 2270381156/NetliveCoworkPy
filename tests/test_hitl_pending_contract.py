"""前端契约派生规则守护：`/hitl/pending` 的 kind 由 form 派生（approval→approval,否则→input）,
form 字段原样透传。与 test_session_entry_paused.py 的 SSE 翻译测试互补,覆盖另一处派生点
（`api/hitl.py::list_pending`）。
"""

from __future__ import annotations

import pytest

from ctx_weft.core.state.models import HitlRequest
from netlivecowork.api import hitl as hitl_api


class _StubHitlManager:
    def __init__(self, pending: list[HitlRequest]) -> None:
        self._pending = pending

    def list_pending(self, session_id: str | None = None) -> list[HitlRequest]:
        return self._pending


async def test_list_pending_derives_kind_from_form() -> None:
    approval_req = HitlRequest(
        id="h1", form="approval", session_id="s1", task_id="t1",
        capability_id="fs:bash_exec", question="Allow this?",
        arguments={"cmd": "ls"}, questions=[{"question": "q?"}],
    )
    question_req = HitlRequest(
        id="h2", form="question", session_id="s1", task_id="t1",
        capability_id="control:ask_user", question="Pick one",
    )
    hitl = _StubHitlManager([approval_req, question_req])

    items = await hitl_api.list_pending(session_id="s1", hitl=hitl)

    by_id = {item.id: item for item in items}
    assert by_id["h1"].kind == "approval"
    assert by_id["h1"].form == "approval"
    assert by_id["h2"].kind == "input"
    assert by_id["h2"].form == "question"

    # 新增 additive 字段透传(多面板渲染用);既有字段与取值不变
    assert by_id["h1"].arguments == {"cmd": "ls"}
    assert by_id["h1"].questions == [{"question": "q?"}]
    assert isinstance(by_id["h1"].created_at, str) and by_id["h1"].created_at

    # 未传 arguments/questions 的条目:缺省 {}/[]
    assert by_id["h2"].arguments == {}
    assert by_id["h2"].questions == []
