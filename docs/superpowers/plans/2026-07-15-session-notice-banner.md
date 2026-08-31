# 会话通告框（session_notice）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话 FAILED/INTERRUPTED 时在对话框底部显示带真实原因的通告框（熔断带连败清单、中断带准确成因 + 换模型恢复），点「继续对话/恢复会话」回到聊天。

**Architecture:** host 翻译层（SessionEntry.apply）合成一条新的持久化 SSE 帧 `session_notice`，走既有落库 + history 快照 + 重启重灌链路（零 DB migration、core 零改动）；前端 `useSessionSSE` 捕获最后一条 notice，新组件 `SessionNoticeBar` 在 FAILED/INTERRUPTED 时替换输入区。

**Tech Stack:** Python 3.11 + pytest（host，`uv run pytest`）；React 19 + TypeScript + Vite（`frontend/`，无测试框架，验证靠 `npm run build`）。

**Spec:** `docs/superpowers/specs/2026-07-15-session-notice-banner-design.md`（本仓）
**分支:** `feat/session-notice-banner`（基于 feat/run-crash-recoverable-suspend @ ba6110b）

## Global Constraints

- core（ctx-weft）零改动；不 revendor；无 DB migration。
- `session_notice` 帧形状（冻结）：`{type: "session_notice", kind: "failed"|"interrupted", reason_code: str, reason_text: str, failures: [{title, reason}], created_at: ISO}`。
- 熔断的 failed notice 在 **FAILURE_THRESHOLD_HIT** 翻译处合成（素材在手、立刻持久化，崩在 trip 步骤 2~8 之间不丢死因）；`SESSION_STATUS_CHANGED(FAILED, reason="failure_threshold")` **不再**重复合成。
- `_last_task_failure` 与 failure_counter 折叠同判据同生命周期：TASK_FAILED（非 `TASK_FAILED_BY_THRESHOLD` 码）覆盖、TASK_FINISHED 清空。
- 前端显示规则：取最后一条 notice，且仅当 `notice.kind` 与当前 session 状态匹配时用其内容；无 notice 时 FAILED 用通用文案「会话失败」、INTERRUPTED 沿现有「服务重启导致任务中断」。
- 框显示时输入区整体不渲染；FAILED 框点「继续对话」→ 本地 dismissed（不持久化，刷新后框重现）；CANCELED/SUCCEEDED 不出框（药丸保留）。
- 测试命令：host `uv run pytest tests/test_session_notice.py -v`（全量 `uv run pytest`）；前端 `npm run build`（在 `frontend/` 下）。
- 提交信息中文、结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: SessionEntry 素材暂存 + notice 合成 + task_failed 气泡取材增强

**Files:**
- Modify: `src/ipmastercowork/api/models/session.py`（`__init__` ~L117 后；`FAILURE_THRESHOLD_HIT` 分支 ~L484；`SESSION_STATUS_CHANGED` 分支 ~L437；`RUN_FINISHED` 的 task_failed 气泡 ~L472；`TASK_STATUS_BY_EVENT` 折叠段 ~L607；`_HISTORY_TYPES` ~L686；新增 `_session_notice_json` 方法）
- Modify: `docs/superpowers/specs/2026-07-15-session-notice-banner-design.md`（范围外条目修订，见 Step 8）
- Test: `tests/test_session_notice.py`（新建）

**Interfaces:**
- Consumes: `Event`/`EventType`（ctx_weft.core.events.types）；既有 `_session_update_json`、`_now`。
- Produces: `SessionEntry._session_notice_json(kind, reason_code, reason_text, failures, ts) -> str`；`SessionEntry._last_task_failure: dict|None`（键 `code`/`message`）；`SessionEntry._threshold_failures: dict|None`（键 `failures`/`counter`/`threshold`）——Task 2 的回填目标即 `_last_task_failure`；`"session_notice"` ∈ `_HISTORY_TYPES`。

- [ ] **Step 1: 写失败测试**

新建 `tests/test_session_notice.py`（构造器风格镜像 `tests/test_failure_counter_fold.py`）：

```python
"""session_notice 帧合成（spec 2026-07-15-session-notice-banner）：

FAILED/INTERRUPTED 的死因/成因经由持久化 SSE 帧直达前端底部框。
熔断 notice 在 FAILURE_THRESHOLD_HIT 处合成；其余 FAILED 在
SESSION_STATUS_CHANGED 处按 _last_task_failure 素材合成。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from ctx_weft.core.events.types import Event, EventType
from ipmastercowork.api.models.session import _HISTORY_TYPES, SessionEntry

_TS = datetime(2026, 6, 16, tzinfo=timezone.utc)


def _entry(sid: str) -> SessionEntry:
    return SessionEntry(session_id=sid, template_id="t", user_prompt="x",
                        tenant_id="default", llm_model=None, llm_account=None)


def _ev(sid: str, type_: str, **payload) -> Event:
    return Event(id=f"evt_{type_}", run_id="r1", sequence=1,
                 session_id=sid, task_id=payload.pop("task_id", None), type=type_,
                 timestamp=_TS, payload=payload)


def _frames(result) -> list[dict]:
    """translate_event 返回 str | list[str] | None → 统一成 dict 列表。"""
    if result is None:
        return []
    items = result if isinstance(result, list) else [result]
    return [json.loads(x) for x in items]


def _notices(result) -> list[dict]:
    return [f for f in _frames(result) if f.get("type") == "session_notice"]


def test_observer_failure_notice_carries_verdict_summary() -> None:
    e = _entry("s1")
    e.translate_event(_ev("s1", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="观察者判定：输出缺少关键字段"))
    out = e.translate_event(_ev("s1", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    notices = _notices(out)
    assert len(notices) == 1
    n = notices[0]
    assert n["kind"] == "failed"
    assert n["reason_code"] == "TASK_FAILED_BY_OBSERVER"
    assert n["reason_text"] == "观察者判定：输出缺少关键字段"
    assert n["failures"] == []
    # session_update 照常在场
    assert any(f["type"] == "session_update" for f in _frames(out))


def test_threshold_notice_emitted_at_hit_not_at_status_change() -> None:
    e = _entry("s2")
    hit = e.translate_event(_ev(
        "s2", EventType.FAILURE_THRESHOLD_HIT,
        failure_counter=3, threshold=3,
        failures=[{"title": "抓取页面", "reason": "选择器失效"},
                  {"title": "解析数据", "reason": "格式不符"},
                  {"title": "重试抓取", "reason": "选择器仍失效"}]))
    notices = _notices(hit)
    assert len(notices) == 1
    n = notices[0]
    assert n["kind"] == "failed"
    assert n["reason_code"] == "TASK_FAILED_BY_THRESHOLD"
    assert "3" in n["reason_text"]
    assert len(n["failures"]) == 3
    assert n["failures"][0] == {"title": "抓取页面", "reason": "选择器失效"}
    # reason=failure_threshold 的 FAILED 不再重复合成
    out = e.translate_event(_ev("s2", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED", reason="failure_threshold"))
    assert _notices(out) == []
    assert any(f["type"] == "session_update" for f in _frames(out))


def test_task_finished_clears_failure_material() -> None:
    e = _entry("s3")
    e.translate_event(_ev("s3", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="第一次失败"))
    e.translate_event(_ev("s3", EventType.TASK_FINISHED, task_id="tsk_1"))
    out = e.translate_event(_ev("s3", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "SESSION_FAILED"
    assert n["reason_text"] == "会话失败"


def test_threshold_code_does_not_overwrite_material() -> None:
    e = _entry("s4")
    e.translate_event(_ev("s4", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="真实死因"))
    e.translate_event(_ev("s4", EventType.TASK_FAILED, task_id="tsk_root",
                          error_code="TASK_FAILED_BY_THRESHOLD",
                          error_message="Session failure threshold reached (3)."))
    assert e._last_task_failure == {"code": "TASK_FAILED_BY_OBSERVER",
                                    "message": "真实死因"}


def test_generic_fallback_without_material() -> None:
    e = _entry("s5")
    out = e.translate_event(_ev("s5", EventType.SESSION_STATUS_CHANGED,
                                new_status="FAILED"))
    n = _notices(out)[0]
    assert n["reason_code"] == "SESSION_FAILED"


def test_interrupted_notice_passes_reason_code() -> None:
    e = _entry("s6")
    out = e.translate_event(_ev("s6", EventType.SESSION_STATUS_CHANGED,
                                new_status="INTERRUPTED",
                                reason="CONTEXT_OVERFLOW"))
    n = _notices(out)[0]
    assert n["kind"] == "interrupted"
    assert n["reason_code"] == "CONTEXT_OVERFLOW"
    # session_update 的 interrupt_reason 老契约不回归
    upd = [f for f in _frames(out) if f["type"] == "session_update"][0]
    assert upd["interrupt_reason"] == "CONTEXT_OVERFLOW"


def test_non_terminal_status_change_has_no_notice() -> None:
    e = _entry("s7")
    out = e.translate_event(_ev("s7", EventType.SESSION_STATUS_CHANGED,
                                new_status="RUNNING"))
    assert _notices(out) == []


def test_session_notice_in_history_types() -> None:
    assert "session_notice" in _HISTORY_TYPES


def test_task_failed_bubble_falls_back_to_observer_summary() -> None:
    """observer 判死时 run_error 为 None → 气泡不再是通用 'Task failed'，
    回落到 TASK_FAILED 暂存的判决摘要（持久化帧由此跨重启保持精确）。"""
    e = _entry("s8")
    e.translate_event(_ev("s8", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="观察者判定：结果为空"))
    out = e.translate_event(_ev("s8", EventType.RUN_FINISHED, task_id="tsk_1",
                                final_status="FAILED", will_retry=False,
                                error=None, error_type=None))
    bubble = [f for f in _frames(out) if f.get("type") == "task_failed"][0]
    assert bubble["error"] == "观察者判定：结果为空"


def test_task_failed_bubble_prefers_run_error_when_present() -> None:
    e = _entry("s9")
    e.translate_event(_ev("s9", EventType.TASK_FAILED, task_id="tsk_1",
                          error_code="TASK_FAILED_BY_OBSERVER",
                          error_message="旧素材"))
    out = e.translate_event(_ev("s9", EventType.RUN_FINISHED, task_id="tsk_1",
                                final_status="FAILED", will_retry=False,
                                error="RuntimeError: boom", error_type="RuntimeError"))
    bubble = [f for f in _frames(out) if f.get("type") == "task_failed"][0]
    assert bubble["error"] == "RuntimeError: boom"
```

- [ ] **Step 2: 跑测试确认全红**

Run: `uv run pytest tests/test_session_notice.py -v`
Expected: FAIL——`test_session_notice_in_history_types` 断言失败；notice 相关测试因 `_notices(out) == []` 或 `IndexError` 失败；气泡测试断言 `'Task failed'` ≠ 判决摘要。

- [ ] **Step 3: 实现——`__init__` 素材字段**

在 `session.py` `__init__` 的 `self.interrupt_reason` 行（~L117）之后加：

```python
        # ── session_notice 素材暂存（spec 2026-07-15 session-notice-banner）──
        # _last_task_failure: 最近一次真实任务失败的 {code, message}。TASK_FAILED
        # （非熔断聚合码）覆盖、TASK_FINISHED 清空——与 failure_counter 折叠同判据，
        # 保证会话判 FAILED 时它就是「导致失败的那次」。
        # _threshold_failures: 熔断连败清单，FAILURE_THRESHOLD_HIT 时整包记下。
        self._last_task_failure: dict[str, str] | None = None
        self._threshold_failures: dict[str, Any] | None = None
```

- [ ] **Step 4: 实现——notice 帧 builder + 四处翻译分支**

4a. 在 `_session_update_json` 方法后新增：

```python
    def _session_notice_json(self, *, kind: str, reason_code: str,
                             reason_text: str, failures: list, ts: str) -> str:
        """会话通告帧：FAILED 死因 / INTERRUPTED 成因直达前端底部框。
        进 _HISTORY_TYPES（落库 + history 快照 + 重启重灌），前端取最后一条、
        仅当 kind 与当前 session 状态匹配时显示。"""
        return json.dumps({
            "type": "session_notice",
            "kind": kind,
            "reason_code": reason_code,
            "reason_text": reason_text,
            "failures": failures,
            "created_at": ts,
        })
```

4b. 替换 `FAILURE_THRESHOLD_HIT` 分支（现为记注释后 `return None`，~L484-489）：

```python
        if t == EventType.FAILURE_THRESHOLD_HIT:
            # failure_counter 真折叠（与 core reducer / postgres 投影三处同义）：
            # 熔断补标的聚合失败（TASK_FAILED_BY_THRESHOLD）不是「新的一次失败」，不计数；
            # 计数改由下方 TASK_STATUS_BY_EVENT 分支里的 TASK_FAILED/TASK_FINISHED 承担。
            # 熔断必然走到 SESSION_STATUS_CHANGED(FAILED)（trip 序列步骤 2→8 无条件），
            # failed notice 在此即刻合成：素材（连败清单）在手且立刻持久化，崩在
            # 步骤 2~8 之间也不丢死因；STATUS_CHANGED(reason=failure_threshold) 不再重复合成。
            self._threshold_failures = {
                "failures": p.get("failures") or [],
                "counter": p.get("failure_counter", 0),
                "threshold": p.get("threshold", 0),
            }
            self.updated_at = _now()
            return self._session_notice_json(
                kind="failed",
                reason_code="TASK_FAILED_BY_THRESHOLD",
                reason_text=(
                    f"连续 {self._threshold_failures['counter']} 次子任务失败，"
                    f"达到熔断阈值（{self._threshold_failures['threshold']}），会话已终止"
                ),
                failures=self._threshold_failures["failures"],
                ts=ts,
            )
```

4c. 替换 `SESSION_STATUS_CHANGED` 分支（~L437-445）：

```python
        if t == EventType.SESSION_STATUS_CHANGED:
            new_status = p.get("new_status") or p.get("status", "")
            if new_status:
                self.status = new_status
                self.updated_at = _now()
                # 仅 INTERRUPTED 记成因;离开中断态(如 resume→RUNNING)清空,避免旧成因泄漏。
                self.interrupt_reason = p.get("reason") if new_status == "INTERRUPTED" else None
                update = self._session_update_json(new_status)
                # ── session_notice 合成 ──
                # FAILED 素材优先级：熔断（已在 FAILURE_THRESHOLD_HIT 处合成，跳过）
                # > 最近真实失败（observer 判决摘要）> 通用兜底。
                # INTERRUPTED：reason_code 透传，展示文案由前端按 code 映射。
                if new_status == "FAILED" and p.get("reason") != "failure_threshold":
                    lf = self._last_task_failure or {}
                    return [update, self._session_notice_json(
                        kind="failed",
                        reason_code=lf.get("code") or "SESSION_FAILED",
                        reason_text=lf.get("message") or "会话失败",
                        failures=[],
                        ts=ts,
                    )]
                if new_status == "INTERRUPTED":
                    return [update, self._session_notice_json(
                        kind="interrupted",
                        reason_code=p.get("reason") or "",
                        reason_text="任务被中断",
                        failures=[],
                        ts=ts,
                    )]
                return update
            return None
```

4d. 扩展 `TASK_STATUS_BY_EVENT` 分支里的折叠段（~L607-615）——`TASK_FAILED` 加素材记录、`TASK_FINISHED` 加清空：

```python
            if t == EventType.TASK_FAILED:
                if (p or {}).get("error_code") != "TASK_FAILED_BY_THRESHOLD":
                    self.failure_counter += 1
                    # notice 素材：与计数同判据同生命周期（FINISHED 一并清空）。
                    self._last_task_failure = {
                        "code": (p or {}).get("error_code") or "TASK_FAILED",
                        "message": (p or {}).get("error_message") or (p or {}).get("error") or "",
                    }
            elif t == EventType.TASK_FINISHED:
                self.failure_counter = 0
                self._last_task_failure = None
```

4e. `RUN_FINISHED` 的 task_failed 气泡（~L472-481）——error 回落链插入素材：

```python
            if final_status == "FAILED" or will_retry or crashed_suspend:
                self.updated_at = _now()
                return json.dumps({
                    "type": "task_failed",
                    # observer 判死时 run_error 为 None（run 正常收尾、死因在 verdict 里）——
                    # 回落到 TASK_FAILED 暂存的判决摘要：气泡与持久化帧都带真实死因，
                    # restore 回填（_load_entry_children）据此跨重启保持精确。
                    "error": (p.get("error")
                              or (self._last_task_failure or {}).get("message")
                              or "Task failed"),
                    "error_type": p.get("error_type", ""),
                    "will_retry": will_retry,
                    "recoverable": crashed_suspend,
                    "created_at": ts,
                })
```

4f. `_HISTORY_TYPES`（~L686）加一行 `"session_notice",`（放 `"context_compacted",` 之前）。

- [ ] **Step 5: 跑新测试确认全绿**

Run: `uv run pytest tests/test_session_notice.py -v`
Expected: 10 passed

- [ ] **Step 6: 跑相邻回归**

Run: `uv run pytest tests/test_failure_counter_fold.py tests/test_resume_model_switch_api.py -v`
Expected: 全 PASS（折叠语义未动，只是同分支加了素材记录；若 `test_failure_counter_fold` 有测试直接断言 `SESSION_STATUS_CHANGED`/`FAILURE_THRESHOLD_HIT` 的返回**形状**为单 str/None，按新契约（list/notice 帧）更新该断言并在报告中注明）

- [ ] **Step 7: host 全量回归**

Run: `uv run pytest`
Expected: 全 PASS（已知 flaky：`test_postgres_snapshot_prune_keeps_latest_n`、`test_double_pause_during_resume_keeps_session_recoverable`——失败则隔离复跑判定）

- [ ] **Step 8: 修订 spec（两处计划阶段的偏离）**

`docs/superpowers/specs/2026-07-15-session-notice-banner-design.md` 中：

8a. 范围外条目：

```
旧：- `task_failed` 气泡自身的文案改进（notice 已承载原因；气泡通用文案维持现状）。
新：- ~~`task_failed` 气泡文案改进~~（计划阶段收回：气泡 error 回落到 `_last_task_failure.message`
  是 restore 回填跨重启精确的前提——持久化的气泡帧就是回填素材，顺带修复 observer 判死
  气泡永远是通用文案的缺口）。
```

8b. ② 节熔断合成位置（原文写在 SESSION_STATUS_CHANGED 处按优先级 1 合成）：

```
旧：  1. `p.reason == "failure_threshold"` 且 `_threshold_failures` 非空 →
     `code=TASK_FAILED_BY_THRESHOLD`，text=「连续 N 次子任务失败，达到熔断阈值，会话已终止」，
     `failures`=清单；
新：  1. 熔断的 failed notice 改在 **FAILURE_THRESHOLD_HIT 翻译处**即刻合成
     （`code=TASK_FAILED_BY_THRESHOLD` + 清单；素材在手且立刻持久化，崩在 trip
     步骤 2~8 之间不丢死因）；`SESSION_STATUS_CHANGED(FAILED, reason="failure_threshold")`
     不再重复合成，只发 session_update；
```

- [ ] **Step 9: Commit**

```bash
git add src/ipmastercowork/api/models/session.py tests/test_session_notice.py docs/superpowers/specs/2026-07-15-session-notice-banner-design.md
git commit -m "feat(sse): session_notice 帧——FAILED/INTERRUPTED 死因直达前端

SessionEntry 暂存 notice 素材（_last_task_failure 与 counter 折叠同判据，
_threshold_failures 记熔断清单）；熔断 notice 在 FAILURE_THRESHOLD_HIT 处
合成（崩在 trip 中段不丢死因），其余 FAILED/INTERRUPTED 在
SESSION_STATUS_CHANGED 处合成；task_failed 气泡 error 回落判决摘要；
session_notice 进 _HISTORY_TYPES（落库+快照+重启重灌免费）。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: restore 回填——host 重启后 notice 素材从持久化气泡恢复

**Files:**
- Modify: `src/ipmastercowork/api/models/session.py`（`_load_entry_children` ~L884-900；其前新增模块级函数 `_last_task_failure_from`）
- Test: `tests/test_session_notice.py`（追加）

**Interfaces:**
- Consumes: Task 1 的 `SessionEntry._last_task_failure`（键 `code`/`message`）；task_failed 气泡帧形状 `{type, error, error_type, will_retry, recoverable, created_at}`。
- Produces: `_last_task_failure_from(sse_events: list[str]) -> dict[str, str] | None`（模块级，测试直接 import）。

- [ ] **Step 1: 写失败测试**

追加到 `tests/test_session_notice.py`：

```python
# ── restore 回填（Task 2）──────────────────────────────────────────────────────

from ipmastercowork.api.models.session import _last_task_failure_from


def test_backfill_takes_last_terminal_task_failed() -> None:
    events = [
        json.dumps({"type": "message", "role": "user", "content": "hi"}),
        json.dumps({"type": "task_failed", "error": "第一次失败", "error_type": "",
                    "will_retry": False, "created_at": "t1"}),
        json.dumps({"type": "task_failed", "error": "致败原因", "error_type": "",
                    "will_retry": False, "created_at": "t2"}),
    ]
    assert _last_task_failure_from(events) == {"code": "TASK_FAILED",
                                               "message": "致败原因"}


def test_backfill_skips_retry_and_recoverable_bubbles() -> None:
    events = [
        json.dumps({"type": "task_failed", "error": "终态失败", "error_type": "",
                    "will_retry": False, "created_at": "t1"}),
        json.dumps({"type": "task_failed", "error": "重试中", "error_type": "",
                    "will_retry": True, "created_at": "t2"}),
        json.dumps({"type": "task_failed", "error": "崩溃挂起", "error_type": "LLMCallError",
                    "will_retry": False, "recoverable": True, "created_at": "t3"}),
    ]
    assert _last_task_failure_from(events) == {"code": "TASK_FAILED",
                                               "message": "终态失败"}


def test_backfill_none_without_failures() -> None:
    events = [json.dumps({"type": "message", "role": "user", "content": "hi"})]
    assert _last_task_failure_from(events) is None
    assert _last_task_failure_from([]) is None


def test_backfill_uses_error_type_as_code() -> None:
    events = [json.dumps({"type": "task_failed", "error": "boom",
                          "error_type": "RuntimeError",
                          "will_retry": False, "created_at": "t1"})]
    assert _last_task_failure_from(events) == {"code": "RuntimeError",
                                               "message": "boom"}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_session_notice.py -v -k backfill`
Expected: FAIL——`ImportError: cannot import name '_last_task_failure_from'`

- [ ] **Step 3: 实现**

在 `session.py` 的 `_count_user_turns`（~L865）后新增：

```python
def _last_task_failure_from(sse_events: list[str]) -> dict[str, str] | None:
    """从持久化 sse_events 尾部找最后一条**终态**失败气泡，回填 notice 素材。

    只为「崩溃后恢复收尾判死」（runtime finalize_idle_session）兜底取材——那条路的
    SESSION_STATUS_CHANGED(FAILED) 发生在重启后的新进程里，内存素材已丢。取最后一条
    即可：counter 折叠语义保证能判 FAILED 就意味着最后一次失败之后没有成功清零。
    跳过 will_retry（自动重试非终态）与 recoverable（崩溃挂起非失败）气泡。
    """
    for raw in reversed(sse_events):
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        if (ev.get("type") == "task_failed"
                and not ev.get("will_retry") and not ev.get("recoverable")):
            return {"code": ev.get("error_type") or "TASK_FAILED",
                    "message": ev.get("error") or ""}
    return None
```

`_load_entry_children` 末尾（`entry.turn_seq = ...` 之后）加：

```python
    # notice 素材跨重启回填：崩溃后恢复收尾判死时，死因取自持久化的最后一条终态失败气泡。
    entry._last_task_failure = _last_task_failure_from(entry.sse_events)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_session_notice.py -v`
Expected: 14 passed

- [ ] **Step 5: host 全量回归**

Run: `uv run pytest`
Expected: 全 PASS（同 Task 1 flaky 说明）

- [ ] **Step 6: Commit**

```bash
git add src/ipmastercowork/api/models/session.py tests/test_session_notice.py
git commit -m "feat(sse): restore 回填 notice 素材——崩溃后恢复收尾判死不丢死因

_load_entry_children 从持久化 sse_events 尾部取最后一条终态失败气泡
（跳过 will_retry/recoverable）回填 _last_task_failure。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 前端管道——notice 状态 + /resume 可选换模型 body

**Files:**
- Modify: `frontend/src/hooks/useSessionSSE.ts`（类型区 ~L200；history 循环 ~L501-559；`session_update` 处理 ~L627 附近新增 live 分支；`init` 非重连分支 ~L561-）
- Modify: `frontend/src/api/sessions.ts`（resume 签名 L15）

**Interfaces:**
- Consumes: Task 1 冻结的 `session_notice` 帧形状。
- Produces: `export interface SessionNotice { kind: 'failed' | 'interrupted'; reason_code: string; reason_text: string; failures: Array<{ title: string; reason: string }>; created_at: string }`；`SSEState.notice: SessionNotice | null`（hook 返回值随 state 透出）；`sessionsApi.resume(id, body?: { llm_account?: string | null; llm_model?: string | null })`——Task 4 的组件消费这两者。

- [ ] **Step 1: useSessionSSE.ts——类型与状态**

`ChatCompactMarker` 接口之后（~L184）加：

```typescript
export interface SessionNotice {
  kind: 'failed' | 'interrupted'
  reason_code: string
  reason_text: string
  failures: Array<{ title: string; reason: string }>
  created_at: string
}
```

`SSEState` 接口（~L202）加字段 `notice: SessionNotice | null`；`useState` 初始对象（~L226）加 `notice: null,`。

新增解析 helper（放 `uid()` 函数后）：

```typescript
function noticeFrom(evt: Record<string, unknown>): SessionNotice {
  return {
    kind: (evt.kind as SessionNotice['kind']) || 'failed',
    reason_code: (evt.reason_code as string) || '',
    reason_text: (evt.reason_text as string) || '',
    failures: (evt.failures as Array<{ title: string; reason: string }>) || [],
    created_at: (evt.created_at as string) || '',
  }
}
```

- [ ] **Step 2: history 捕获最后一条 notice**

history 分支（~L501）的局部变量区加 `let lastNotice: SessionNotice | null = null`；循环体中（`session_update` 提取块之后）加：

```typescript
          if (evtType === 'session_notice') {
            lastNotice = noticeFrom(evt)
            continue
          }
```

history 末尾的 `setState`（~L550-557）返回对象加 `notice: lastNotice,`（fresh connect 的 history 是全量重放，直接以重放结果为准，不保留旧值）。

- [ ] **Step 3: live 流处理 + init 复位**

`session_update` live 分支（~L627）之前加：

```typescript
      if (type === 'session_notice') {
        setState(s => ({ ...s, notice: noticeFrom(data) }))
        return
      }
```

`init` 处理的**非重连**分支（`isReconnect` 为 false 的返回对象）加 `notice: null,`（换会话冷连时清旧值，随后的 history 批次重建）；重连分支不动（保留已有 notice）。

- [ ] **Step 4: api/sessions.ts——resume 可选 body**

L15 替换为：

```typescript
  resume: (id: string, body?: { llm_account?: string | null; llm_model?: string | null }) =>
    http.post<Session>(`/sessions/${id}/resume`, body),
```

（后端 `/resume` 的 `ResumeSessionRequest` v1 起即为可选 body，无 body 行为不变。）

- [ ] **Step 5: 构建验证**

Run: `cd frontend; npm run build`
Expected: `tsc -b` 零错误，vite build 成功（此步只有类型与死代码，UI 未接——Task 4 接线）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useSessionSSE.ts frontend/src/api/sessions.ts
git commit -m "feat(frontend): session_notice 状态管道 + /resume 可选换模型 body

useSessionSSE 捕获最后一条 notice（history 重放与 live 流两路），
init 冷连复位；sessionsApi.resume 支持 {llm_account, llm_model}。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: SessionNoticeBar 组件 + ChatPanel 接线

**Files:**
- Create: `frontend/src/components/chat/SessionNoticeBar.tsx`
- Modify: `frontend/src/components/chat/ChatPanel.tsx`（删 INTERRUPTED 横幅 ~L1284-1301；终态药丸收窄 ~L1303-1322；resumeMutation ~L1135-1141；输入区条件 ~L1356-1368；顶部 import）

**Interfaces:**
- Consumes: Task 3 的 `SessionNotice`、`SSEState.notice`、`sessionsApi.resume(id, body?)`；`llmsApi.list`（`@/api/llms`，与 ChatPanel 既有用法同源）。
- Produces: `SessionNoticeBar` 组件，props：`{ status: 'FAILED' | 'INTERRUPTED'; notice: SessionNotice | null; onContinue: () => void; onResume: (llm?: { llm_account?: string; llm_model?: string }) => void; resumePending: boolean }`。

- [ ] **Step 1: 新建组件**

`frontend/src/components/chat/SessionNoticeBar.tsx`：

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, MessageSquarePlus, RotateCcw, XCircle } from 'lucide-react'
import { llmsApi } from '@/api/llms'
import type { SessionNotice } from '@/hooks/useSessionSSE'

// INTERRUPTED 成因 → 人话文案；未知 code 走模板，无 code 沿旧文案（存量会话无 notice）。
const INTERRUPT_TEXT: Record<string, string> = {
  llm_outage: 'LLM 连接中断，任务已挂起',
  CONTEXT_OVERFLOW: '上下文超出模型窗口，建议换更大窗口的模型后恢复',
}

function interruptText(notice: SessionNotice | null): string {
  if (!notice || !notice.reason_code) return '服务重启导致任务中断'
  return INTERRUPT_TEXT[notice.reason_code] ?? `服务异常导致任务中断（${notice.reason_code}）`
}

export function SessionNoticeBar({
  status,
  notice,
  onContinue,
  onResume,
  resumePending,
}: {
  status: 'FAILED' | 'INTERRUPTED'
  notice: SessionNotice | null
  onContinue: () => void
  onResume: (llm?: { llm_account?: string; llm_model?: string }) => void
  resumePending: boolean
}) {
  // kind 与当前状态不匹配的陈旧 notice（如中断→恢复→失败的旧帧）不当作素材。
  const wanted = status === 'FAILED' ? 'failed' : 'interrupted'
  const n = notice && notice.kind === wanted ? notice : null

  const [showFailures, setShowFailures] = useState(false)
  const [llmAccount, setLlmAccount] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const { data: llms = [] } = useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })
  const selectedProvider = llms.find(l => l.name === llmAccount)

  if (status === 'FAILED') {
    return (
      <div className="border-t border-red-200 bg-red-50 p-3">
        <div className="flex items-start gap-2">
          <XCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-700">会话失败</p>
            <p className="mt-0.5 text-xs text-red-600 break-words">
              {n?.reason_text || '会话失败'}
            </p>
            {n && n.failures.length > 0 && (
              <div className="mt-1.5">
                <button
                  onClick={() => setShowFailures(v => !v)}
                  className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 transition-colors"
                >
                  {showFailures ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  查看 {n.failures.length} 条失败记录
                </button>
                {showFailures && (
                  <ul className="mt-1 space-y-1">
                    {n.failures.map((f, i) => (
                      <li key={i} className="text-xs text-red-600 pl-4">
                        <span className="font-medium">{f.title || '（未命名任务）'}</span>
                        {f.reason ? `：${f.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onContinue}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs hover:bg-red-600 transition-colors flex-shrink-0"
          >
            <MessageSquarePlus size={12} />
            继续对话
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-orange-200 bg-orange-50 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-orange-700 flex-1 min-w-0">{interruptText(n)}</span>
        {n?.reason_code === 'CONTEXT_OVERFLOW' && (
          <>
            <select
              value={llmAccount}
              onChange={e => { setLlmAccount(e.target.value); setLlmModel('') }}
              className="text-xs border border-orange-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-orange-400"
            >
              <option value="">沿用当前账号</option>
              {llms.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
            </select>
            {selectedProvider && selectedProvider.models.length > 0 && (
              <select
                value={llmModel}
                onChange={e => setLlmModel(e.target.value)}
                className="text-xs border border-orange-200 rounded px-1.5 py-0.5 text-gray-600 bg-white focus:outline-none focus:border-orange-400"
              >
                <option value="">默认（{selectedProvider.default_model}）</option>
                {selectedProvider.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            )}
          </>
        )}
        <button
          onClick={() => onResume(llmAccount
            ? { llm_account: llmAccount, ...(llmModel ? { llm_model: llmModel } : {}) }
            : undefined)}
          disabled={resumePending}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-orange-500 text-white text-xs hover:bg-orange-600 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {resumePending ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          恢复会话
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: ChatPanel 接线**

2a. 顶部 import 加：`import { SessionNoticeBar } from './SessionNoticeBar'`。

2b. 从 `useSessionSSE` 解构处补 `notice`（该 hook 返回 `SSEState & {reconnect}`，已含字段）。

2c. `resumeMutation`（~L1135）改为带可选 body：

```tsx
  const resumeMutation = useMutation({
    mutationFn: (body?: { llm_account?: string; llm_model?: string }) =>
      sessionsApi.resume(sessionId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      reconnect()
    },
  })
```

2d. 组件状态区加（`showTasks` 旁）：

```tsx
  // FAILED 框「继续对话」的本地关栏标记：不持久化，刷新后若仍 FAILED 框重现；换会话复位。
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  useEffect(() => { setNoticeDismissed(false) }, [sessionId])
```

2e. **删除** INTERRUPTED 横幅整块（`{/* Interrupted status */}` ~L1284-1301）。

2f. 终态药丸（~L1303-1322）收窄为 SUCCEEDED/CANCELED（FAILED 的信息由底部框承担）：

```tsx
        {/* Terminal status（FAILED 由底部 SessionNoticeBar 呈现）*/}
        {session && (session.status === 'SUCCEEDED' || session.status === 'CANCELED') && (
          <div className="flex justify-center">
            <div className={clsx(
              'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full',
              session.status === 'SUCCEEDED' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
            )}>
              {session.status === 'SUCCEEDED' && <CheckCircle2 size={11} />}
              <span>{session.status === 'SUCCEEDED' ? '会话已完成' : '会话已取消'}</span>
            </div>
          </div>
        )}
```

（`XCircle` 若在本文件仅剩 ErrorEventCard 使用则保留 import；`isTerminal` 若因此不再被引用则一并删除该变量。）

2g. 输入区条件（~L1356-1368）替换：

```tsx
      {/* Input area：FAILED（未点继续）/INTERRUPTED 时由通告框整体替换输入框 */}
      {waitingInput ? (
        <WaitingInputArea sessionId={sessionId} waitingInput={waitingInput} />
      ) : isInterrupted || (session?.status === 'FAILED' && !noticeDismissed) ? (
        <SessionNoticeBar
          status={isInterrupted ? 'INTERRUPTED' : 'FAILED'}
          notice={notice}
          onContinue={() => setNoticeDismissed(true)}
          onResume={llm => resumeMutation.mutate(llm)}
          resumePending={resumeMutation.isPending}
        />
      ) : (
        <TextInput
          sessionId={sessionId}
          session={session ?? null}
          disabled={isRunning}
          onReconnect={reconnect}
          onInterrupt={() => interruptMutation.mutate()}
          interruptPending={interruptMutation.isPending}
        />
      )}
```

- [ ] **Step 3: 构建验证**

Run: `cd frontend; npm run build`
Expected: `tsc -b` 零错误（含未使用变量检查），vite build 成功。

- [ ] **Step 4: lint**

Run: `cd frontend; npm run lint`
Expected: 无新增告警（存量告警不管）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/chat/SessionNoticeBar.tsx frontend/src/components/chat/ChatPanel.tsx
git commit -m "feat(frontend): SessionNoticeBar——失败/中断底部通告框替换输入区

FAILED：死因+熔断连败清单（可展开）+继续对话（本地关栏复显输入框）；
INTERRUPTED：按 reason_code 定制文案，CONTEXT_OVERFLOW 挂账号/模型选择器，
恢复带 body 调 /resume。删旧 INTERRUPTED 横幅与 FAILED 药丸。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 两侧收尾回归

**Files:**
- 无新改动（纯验证；发现问题按 TDD 补修并在报告中列明）

**Interfaces:**
- Consumes: Tasks 1-4 全部产物。
- Produces: 绿色基线（host 全量 + 前端 build/lint）。

- [ ] **Step 1: host 全量**

Run: `uv run pytest`
Expected: 全 PASS（已知 flaky 两例失败则隔离复跑判定，与基线一致即放行）

- [ ] **Step 2: 前端构建 + lint**

Run: `cd frontend; npm run build; npm run lint`
Expected: build 零错误；lint 无新增告警

- [ ] **Step 3: 收尾提交（如有修补）**

仅当 Step 1/2 触发修补时：

```bash
git add -A
git commit -m "fix: 收尾回归修补——<按实际内容>

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 追加：移植到 frontend-desktop（真正打包发布的前端）

**背景修正：** Tasks 3-4 落在了 `frontend/`——该目录未被任何打包/启动链路引用（`build_electron.ps1` 构建、PyInstaller spec 内嵌、Electron 生产模式加载的都是 **`frontend-desktop/`**）。用户定案：`frontend/` 的改动保留，前端能力**移植**到 `frontend-desktop`。host 侧（Tasks 1-2）不受影响。

**frontend-desktop 与 frontend 的关键差异（移植时的约束）：**
- 有 i18n 层（`src/i18n.tsx`，zh ~L180 区 / en ~L430 区成对维护，`t('key', {params})` 占位符 `{name}`）——所有新文案必须走 i18n，不得硬编码。
- 有 vitest（`npm run test`；hook 测试用 MockEventSource 惯例，见 `src/hooks/useSessionSSE.finishBubble.test.tsx`）——新逻辑要有真测试。
- 无 lint script——验证是 `npm run build`（tsc -b + vite build）+ `npm run test`。
- 组件平铺在 `src/components/`（无 chat/ 子目录）；样式以内联 style + CSS 变量（`var(--r)`、`var(--t2)` 等）为主，配 `@/components/ui/button` 的 `Button`。
- ChatPanel 已有一个**内联** INTERRUPTED 横幅（~L737-758，消费 `sse.interruptReason`，llm_outage 红色调特判，按钮调 `resumeMut`），且 INTERRUPTED 时已替换 Composer（~L761 `!isInterrupted &&`）——移植是把它**收编**进统一组件并补 FAILED 侧，不是从零加。
- `providers` 列表 ChatPanel 已有（~L309 `useQuery({queryKey:['llms']})`）——模型选择器**从 props 传入**，不在组件内重复 useQuery（吸收 Task 4 的 Minor）。
- FAILED 相关既有物：`LLMErrorModal`（task_failed 且 error_type=LLMCallError 的终态弹窗）**保留不动**——它与本框正交（弹窗=LLM 调用层错误详情+上报引导；本框=会话级死因+继续对话）。

### Task 6: frontend-desktop hook 管道 + resume body（vitest TDD）

**Files:**
- Modify: `frontend-desktop/src/hooks/useSessionSSE.ts`（SSEState ~L80-118；history 分支 ~L249-301；session_update 分支后 ~L363；`uid()` 附近加 helper）
- Modify: `frontend-desktop/src/api/sessions.ts`（resume L15）
- Test: `frontend-desktop/src/hooks/useSessionSSE.notice.test.tsx`（新建）

**Interfaces:**
- Consumes: host 的 `session_notice` 帧（形状冻结，见 Global Constraints）。
- Produces: `export interface SessionNotice { kind: 'failed' | 'interrupted'; reason_code: string; reason_text: string; failures: Array<{ title: string; reason: string }>; created_at: string }`；`SSEState.notice: SessionNotice | null`；`sessionsApi.resume(id, body?: { llm_account?: string | null; llm_model?: string | null })`——Task 7 消费。

- [ ] **Step 1: 写失败测试**

新建 `frontend-desktop/src/hooks/useSessionSSE.notice.test.tsx`（MockEventSource 惯例复制自 finishBubble.test）：

```tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionSSE } from './useSessionSSE'

// Minimal EventSource stand-in (jsdom has none). Mirrors the finishBubble test's mock.
class MockEventSource {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 2
  static instances: MockEventSource[] = []

  url: string
  readyState = MockEventSource.CONNECTING
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() { this.readyState = MockEventSource.CLOSED }

  open() { this.readyState = MockEventSource.OPEN; this.onopen?.({}) }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

const NOTICE = {
  type: 'session_notice', kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER',
  reason_text: '观察者判定：输出缺少关键字段', failures: [], created_at: 't1',
}

describe('useSessionSSE session_notice pipeline', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource
  })
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource
  })

  function setup() {
    const hook = renderHook(() => useSessionSSE('s1'))
    act(() => { MockEventSource.instances[0].open() })
    return hook
  }

  it('captures a live session_notice into state and NOT into items', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit(NOTICE) })
    expect(result.current.notice).toMatchObject({
      kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER',
      reason_text: '观察者判定：输出缺少关键字段',
    })
    expect(result.current.items).toHaveLength(0)
  })

  it('takes the LAST notice from a history replay, and keeps it out of items', () => {
    const { result } = setup()
    act(() => {
      MockEventSource.instances[0].emit({
        type: 'history',
        events: [
          { ...NOTICE, kind: 'interrupted', reason_code: 'llm_outage', reason_text: '', created_at: 't0' },
          { type: 'message', role: 'user', content: 'hi', created_at: 't0.5' },
          NOTICE,
        ],
      })
    })
    expect(result.current.notice).toMatchObject({ kind: 'failed', reason_code: 'TASK_FAILED_BY_OBSERVER' })
    expect(result.current.items.every(i => i.kind === 'message')).toBe(true)
  })

  it('history replay with no notice clears a previously captured one (full replay wins)', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit(NOTICE) })
    act(() => { MockEventSource.instances[0].emit({ type: 'history', events: [] }) })
    expect(result.current.notice).toBeNull()
  })

  it('parses defensively: missing fields fall back to empty values', () => {
    const { result } = setup()
    act(() => { MockEventSource.instances[0].emit({ type: 'session_notice' }) })
    expect(result.current.notice).toMatchObject({
      kind: 'failed', reason_code: '', reason_text: '', failures: [],
    })
  })
})
```

- [ ] **Step 2: 跑测试确认全红**

Run: `cd frontend-desktop; npm run test -- useSessionSSE.notice`
Expected: FAIL——`notice` 不在返回状态上（TS 编译错或断言 undefined）。

- [ ] **Step 3: 实现——hook 管道**

3a. `SSEState`（~L99 `interruptReason` 之后）加：

```ts
  /** 会话通告（FAILED 死因 / INTERRUPTED 成因，host 合成的持久化帧）；取最后一条，
      kind 与当前 session 状态匹配才消费（ChatPanel/SessionNoticeBar 侧判定）。 */
  notice: SessionNotice | null
```

`EMPTY`（~L117）加 `notice: null,`。

3b. `SessionNotice` 类型（放 `SSEState` 接口之前）+ 解析 helper（放 `uid()` 之后）：

```ts
export interface SessionNotice {
  kind: 'failed' | 'interrupted'
  reason_code: string
  reason_text: string
  failures: Array<{ title: string; reason: string }>
  created_at: string
}
```

```ts
function noticeFrom(evt: Record<string, unknown>): SessionNotice {
  return {
    kind: (evt.kind as SessionNotice['kind']) || 'failed',
    reason_code: (evt.reason_code as string) || '',
    reason_text: (evt.reason_text as string) || '',
    failures: (evt.failures as Array<{ title: string; reason: string }>) || [],
    created_at: (evt.created_at as string) || '',
  }
}
```

3c. history 分支（~L249）：局部变量区加 `let lastNotice: SessionNotice | null = null`；循环内（`waiting_input` 的 continue 旁）加：

```ts
          if (et === 'session_notice') { lastNotice = noticeFrom(evt); continue }
```

末尾 `setState`（~L295-300）的返回对象加 `notice: lastNotice,`（全量重放以重放结果为准，不保留旧值）。

3d. live 分支：`session_update` 块（~L363 `return` 之后）加：

```ts
      if (type === 'session_notice') {
        setState(s => ({ ...s, notice: noticeFrom(data) }))
        return
      }
```

（`init` 无需改：fresh 分支 `{ ...EMPTY, session, items, connected: true }` 经 EMPTY 自带 `notice: null`；重连分支 `...s` 自然保留。）

3e. `api/sessions.ts` resume（保留原注释并更新）：

```ts
  // INTERRUPTED 会话(多为后端重启打断)经事件重放续跑;不接受新文本。
  // 可选 body：换模型恢复（如 CONTEXT_OVERFLOW 换更大窗口），后端 /resume 的
  // ResumeSessionRequest 自带可选语义，无 body 行为不变。
  resume:    (id: string, body?: { llm_account?: string | null; llm_model?: string | null }) =>
    http.post<Session>(`/sessions/${id}/resume`, body),
```

- [ ] **Step 4: 跑测试确认全绿 + 全套回归**

Run: `cd frontend-desktop; npm run test`
Expected: notice 套件 4 passed；既有套件零回归。

- [ ] **Step 5: 构建验证**

Run: `cd frontend-desktop; npm run build`
Expected: `tsc -b` 零错误，vite build 成功。

- [ ] **Step 6: Commit**

```bash
git add frontend-desktop/src/hooks/useSessionSSE.ts frontend-desktop/src/api/sessions.ts frontend-desktop/src/hooks/useSessionSSE.notice.test.tsx
git commit -m "feat(desktop): session_notice 状态管道 + /resume 可选换模型 body

移植自 frontend/（该目录不入打包链路）：useSessionSSE 捕获最后一条
notice（history 重放与 live 两路，不进 items），EMPTY 冷态自带复位；
resume 支持 {llm_account, llm_model}。vitest 4 例覆盖。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: frontend-desktop SessionNoticeBar + ChatPanel 收编 + i18n

**Files:**
- Create: `frontend-desktop/src/components/SessionNoticeBar.tsx`
- Modify: `frontend-desktop/src/components/ChatPanel.tsx`（resumeMut ~L434；INTERRUPTED 内联横幅 ~L737-758 整块替换；Composer 条件 ~L761；状态区 ~L305 附近；顶部 import）
- Modify: `frontend-desktop/src/i18n.tsx`（zh 区 ~L180 chat.* 附近、en 区 ~L430 对应处，成对加键）
- Test: `frontend-desktop/src/components/SessionNoticeBar.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 6 的 `SessionNotice`、`sse.notice`、`sessionsApi.resume(id, body?)`；ChatPanel 既有 `providers`（`llmsApi.list` 的结果，元素含 `name`/`models[].name`/`default_model`）、`sse.interruptReason`、`resumeMut`、`useI18n`。
- Produces: `SessionNoticeBar` 组件，props：`{ status: 'FAILED' | 'INTERRUPTED'; notice: SessionNotice | null; interruptReason: string | null; providers: LLMProvider[]; onContinue: () => void; onResume: (llm?: { llm_account?: string; llm_model?: string }) => void; resumePending: boolean }`（`LLMProvider` 为 `@/types` 中 providers 列表的元素类型——若实名不同（如 `LlmProvider`/`Provider`），按实名引用并在报告中注明）。

- [ ] **Step 1: i18n 键（zh/en 成对）**

zh 区（'chat.interruptedHint' 附近）加：

```ts
  'notice.failedTitle': '会话失败',
  'notice.failedGeneric': '会话失败，未获得可展示的失败原因。',
  'notice.showFailures': '查看 {n} 条失败记录',
  'notice.hideFailures': '收起失败记录',
  'notice.continue': '继续对话',
  'notice.unnamedTask': '（未命名任务）',
  'notice.overflowHint': '上下文超出模型窗口，建议换更大窗口的模型后恢复。',
  'notice.interruptedCode': '服务异常导致任务中断（{code}）。',
  'notice.keepCurrent': '沿用当前账号',
  'notice.defaultModel': '默认（{model}）',
```

en 区（'chat.interruptedHint' 的 en 对应处附近）加：

```ts
  'notice.failedTitle': 'Session failed',
  'notice.failedGeneric': 'The session failed; no displayable failure reason was recorded.',
  'notice.showFailures': 'Show {n} failure records',
  'notice.hideFailures': 'Hide failure records',
  'notice.continue': 'Continue chatting',
  'notice.unnamedTask': '(unnamed task)',
  'notice.overflowHint': 'The context exceeded the model window; switch to a larger-window model and resume.',
  'notice.interruptedCode': 'The task was interrupted by a service error ({code}).',
  'notice.keepCurrent': 'Keep current account',
  'notice.defaultModel': 'Default ({model})',
```

- [ ] **Step 2: 写组件测试（先红）**

新建 `frontend-desktop/src/components/SessionNoticeBar.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '@/i18n'
import { SessionNoticeBar } from './SessionNoticeBar'
import type { SessionNotice } from '@/hooks/useSessionSSE'

const failedNotice: SessionNotice = {
  kind: 'failed', reason_code: 'TASK_FAILED_BY_THRESHOLD',
  reason_text: '连续 3 次子任务失败，达到熔断阈值（3），会话已终止',
  failures: [
    { title: '抓取页面', reason: '选择器失效' },
    { title: '解析数据', reason: '格式不符' },
    { title: '重试抓取', reason: '选择器仍失效' },
  ],
  created_at: 't1',
}

function renderBar(p: Partial<Parameters<typeof SessionNoticeBar>[0]>) {
  return render(
    <I18nProvider>
      <SessionNoticeBar
        status="FAILED" notice={failedNotice} interruptReason={null} providers={[]}
        onContinue={() => {}} onResume={() => {}} resumePending={false}
        {...p}
      />
    </I18nProvider>,
  )
}

describe('SessionNoticeBar', () => {
  it('FAILED: shows reason text, expandable failure list, and fires onContinue', () => {
    const onContinue = vi.fn()
    renderBar({ onContinue })
    expect(screen.getByText(/达到熔断阈值/)).toBeTruthy()
    fireEvent.click(screen.getByText(/查看 3 条失败记录/))
    expect(screen.getByText(/选择器失效/)).toBeTruthy()
    fireEvent.click(screen.getByText('继续对话'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('FAILED with a stale interrupted-kind notice falls back to generic text', () => {
    renderBar({ notice: { ...failedNotice, kind: 'interrupted' } })
    expect(screen.getByText(/未获得可展示的失败原因/)).toBeTruthy()
  })

  it('INTERRUPTED llm_outage uses the LLM-specific hint and fires onResume without body', () => {
    const onResume = vi.fn()
    renderBar({
      status: 'INTERRUPTED', interruptReason: 'llm_outage', onResume,
      notice: { kind: 'interrupted', reason_code: 'llm_outage', reason_text: '', failures: [], created_at: 't' },
    })
    expect(screen.getByText(/LLM 服务连接中断/)).toBeTruthy()
    fireEvent.click(screen.getByText('恢复运行'))
    expect(onResume).toHaveBeenCalledWith(undefined)
  })

  it('INTERRUPTED CONTEXT_OVERFLOW shows model picker and passes selection to onResume', () => {
    const onResume = vi.fn()
    renderBar({
      status: 'INTERRUPTED', interruptReason: 'CONTEXT_OVERFLOW', onResume,
      notice: { kind: 'interrupted', reason_code: 'CONTEXT_OVERFLOW', reason_text: '', failures: [], created_at: 't' },
      providers: [{ name: 'acctA', default_model: 'm1', models: [{ name: 'm1' }, { name: 'm2' }] }] as never,
    })
    expect(screen.getByText(/上下文超出模型窗口/)).toBeTruthy()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'acctA' } })
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'm2' } })
    fireEvent.click(screen.getByText('恢复运行'))
    expect(onResume).toHaveBeenCalledWith({ llm_account: 'acctA', llm_model: 'm2' })
  })
})
```

（`I18nProvider` 的实名与默认语言以仓内既有组件测试（如 `ChatPanel.usertext.test.tsx`）的 i18n 处理惯例为准——若默认非 zh 或 Provider 用法不同，按惯例调整并在报告中注明。）

Run: `cd frontend-desktop; npm run test -- SessionNoticeBar`
Expected: FAIL——组件不存在。

- [ ] **Step 3: 实现组件**

新建 `frontend-desktop/src/components/SessionNoticeBar.tsx`（样式沿既有内联 style + CSS 变量惯例，llm_outage/FAILED/溢出用红色调、其余中断用既有蓝灰调）：

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/i18n'
import type { SessionNotice } from '@/hooks/useSessionSSE'
import type { LLMProvider } from '@/types'

/**
 * 会话通告框：FAILED 死因 / INTERRUPTED 成因，替换输入区（原内联 INTERRUPTED 横幅收编于此）。
 * - FAILED：死因 + 熔断连败清单（默认折叠）+「继续对话」（本地关栏，由 ChatPanel 持有）。
 * - INTERRUPTED：按 interruptReason 分型文案；CONTEXT_OVERFLOW 挂账号/模型选择器，
 *   恢复时把选择传给 /resume（换更大窗口模型续跑）。
 * 陈旧 notice（kind 与当前状态不符，如中断→恢复→失败的旧帧）不作素材。
 */
export function SessionNoticeBar({
  status, notice, interruptReason, providers, onContinue, onResume, resumePending,
}: {
  status: 'FAILED' | 'INTERRUPTED'
  notice: SessionNotice | null
  interruptReason: string | null
  providers: LLMProvider[]
  onContinue: () => void
  onResume: (llm?: { llm_account?: string; llm_model?: string }) => void
  resumePending: boolean
}) {
  const { t } = useI18n()
  const wanted = status === 'FAILED' ? 'failed' : 'interrupted'
  const n = notice && notice.kind === wanted ? notice : null

  const [showFailures, setShowFailures] = useState(false)
  const [llmAccount, setLlmAccount] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const selectedProvider = providers.find(p => p.name === llmAccount)

  if (status === 'FAILED') {
    return (
      <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
          borderRadius: 'var(--r)', border: '1px solid rgba(220,38,38,.3)', background: 'rgba(254,242,242,.7)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#b91c1c' }}>{t('notice.failedTitle')}</div>
            <div style={{ marginTop: 2, fontSize: 12.5, color: '#b91c1c', overflowWrap: 'break-word' }}>
              {n?.reason_text || t('notice.failedGeneric')}
            </div>
            {n && n.failures.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => setShowFailures(v => !v)}
                  style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  {showFailures ? t('notice.hideFailures') : t('notice.showFailures', { n: n.failures.length })}
                </button>
                {showFailures && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {n.failures.map((f, i) => (
                      <li key={i} style={{ fontSize: 12, color: '#b91c1c' }}>
                        <span style={{ fontWeight: 600 }}>{f.title || t('notice.unnamedTask')}</span>
                        {f.reason ? `：${f.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <Button size="sm" onClick={onContinue}>{t('notice.continue')}</Button>
        </div>
      </div>
    )
  }

  // INTERRUPTED：文案分型沿旧横幅语义（llm_outage 专属文案+红调），新增 CONTEXT_OVERFLOW/其他 code。
  const code = interruptReason || n?.reason_code || ''
  const isLlmOutage = code === 'llm_outage'
  const isOverflow = code === 'CONTEXT_OVERFLOW'
  const text = isLlmOutage ? t('llmError.interrupted')
    : isOverflow ? t('notice.overflowHint')
    : code ? t('notice.interruptedCode', { code })
    : t('chat.interruptedHint')
  const tint = isLlmOutage || isOverflow

  return (
    <div style={{ padding: '10px 14px 14px', flexShrink: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flexWrap: 'wrap',
        borderRadius: 'var(--r)',
        border: `1px solid ${tint ? 'rgba(220,38,38,.3)' : 'rgba(138,163,191,.3)'}`,
        background: tint ? 'rgba(254,242,242,.7)' : 'rgba(234,240,251,.5)',
      }}>
        <span style={{ flex: 1, minWidth: 160, fontSize: 12.5, color: tint ? '#b91c1c' : 'var(--t2)' }}>
          {text}
        </span>
        {isOverflow && (
          <>
            <select
              value={llmAccount}
              onChange={e => { setLlmAccount(e.target.value); setLlmModel('') }}
              style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid rgba(138,163,191,.4)' }}
            >
              <option value="">{t('notice.keepCurrent')}</option>
              {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            {selectedProvider && selectedProvider.models.length > 0 && (
              <select
                value={llmModel}
                onChange={e => setLlmModel(e.target.value)}
                style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid rgba(138,163,191,.4)' }}
              >
                <option value="">{t('notice.defaultModel', { model: selectedProvider.default_model })}</option>
                {selectedProvider.models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            )}
          </>
        )}
        <Button
          size="sm" disabled={resumePending}
          onClick={() => onResume(llmAccount
            ? { llm_account: llmAccount, ...(llmModel ? { llm_model: llmModel } : {}) }
            : undefined)}
        >
          {resumePending ? <Spinner className="h-3 w-3" /> : t('chat.resume')}
        </Button>
      </div>
    </div>
  )
}
```

（`Spinner` 的 import 路径与 `LLMProvider` 类型实名以 ChatPanel 现有 import 为准，若不同按实名调整并在报告中注明。）

- [ ] **Step 4: ChatPanel 接线**

4a. import 加 `import { SessionNoticeBar } from './SessionNoticeBar'`。

4b. 状态区（`showNewDialog` 附近）加关栏标记（render 期调整，勿用 useEffect）：

```tsx
  // FAILED 框「继续对话」的本地关栏标记：不持久化；换会话或会话离开 FAILED 均复位
  // （离开不复位的话，同会话二次失败会被旧关栏吞掉）。render 期调整，非 effect。
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [noticeSessionId, setNoticeSessionId] = useState(sessionId)
  if (noticeSessionId !== sessionId) {
    setNoticeSessionId(sessionId)
    setNoticeDismissed(false)
  }
  if (noticeDismissed && session?.status !== 'FAILED') {
    setNoticeDismissed(false)
  }
```

4c. `resumeMut`（~L434）的 mutationFn 改带可选 body（onSuccess 等其余不动；若存在其他无参调用点保持 `resumeMut.mutate(undefined)` 兼容——`mutate()` 不带参即可）：

```tsx
  const resumeMut = useMutation({
    mutationFn: (body?: { llm_account?: string; llm_model?: string }) =>
      sessionsApi.resume(sessionId!, body),
```

4d. 删除内联 INTERRUPTED 横幅整块（~L737-758 的 `{!hasExpandablePanel && isInterrupted && (() => { ... })()}`），原位替换为：

```tsx
      {/* FAILED/INTERRUPTED 会话通告框 —— 取代输入框（原内联 INTERRUPTED 横幅收编）。 */}
      {!hasExpandablePanel && (isInterrupted || (session?.status === 'FAILED' && !noticeDismissed)) && (
        <SessionNoticeBar
          status={isInterrupted ? 'INTERRUPTED' : 'FAILED'}
          notice={sse.notice}
          interruptReason={sse.interruptReason}
          providers={providers}
          onContinue={() => setNoticeDismissed(true)}
          onResume={llm => resumeMut.mutate(llm)}
          resumePending={resumeMut.isPending}
        />
      )}
```

4e. Composer 条件（~L761）由 `{!hasExpandablePanel && !isInterrupted && (` 改为：

```tsx
      {!hasExpandablePanel && !isInterrupted && !(session?.status === 'FAILED' && !noticeDismissed) && (
```

- [ ] **Step 5: 测试全绿 + 全套回归 + 构建**

Run: `cd frontend-desktop; npm run test`
Expected: SessionNoticeBar 4 例 + notice 管道 4 例全过，既有套件零回归。
Run: `cd frontend-desktop; npm run build`
Expected: 零错误。

- [ ] **Step 6: Commit**

```bash
git add frontend-desktop/src/components/SessionNoticeBar.tsx frontend-desktop/src/components/ChatPanel.tsx frontend-desktop/src/i18n.tsx frontend-desktop/src/components/SessionNoticeBar.test.tsx
git commit -m "feat(desktop): SessionNoticeBar——失败/中断通告框替换输入区（收编旧横幅）

FAILED：死因+熔断连败清单（可展开）+继续对话（关栏随离开 FAILED 复位，
二次失败不静默）；INTERRUPTED：收编旧内联横幅，llm_outage 沿专属文案，
新增 CONTEXT_OVERFLOW 挂账号/模型选择器、恢复带 body。文案全走 i18n。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: frontend-desktop 收尾回归

**Files:** 无新改动（纯验证；发现问题按 TDD 补修并在报告中列明）

- [ ] **Step 1:** `cd frontend-desktop; npm run test` → 全套 PASS
- [ ] **Step 2:** `cd frontend-desktop; npm run build` → 零错误
- [ ] **Step 3:** host `uv run pytest` → 全 PASS（已知 flaky 隔离判定）——确认无人误触后端
- [ ] **Step 4:** 仅当有修补时提交
