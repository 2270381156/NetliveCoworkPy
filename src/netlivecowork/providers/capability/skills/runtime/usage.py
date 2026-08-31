"""skill 用量的领域映射 —— **一次 skill 调用是什么、算多久、要不要报**。

只剩这一件事。配置、签名、HTTP 重试退避、失败分类、发不出去时的队列都在
`reporting/sinks/datalink.py`，那五件跟 skill 毫无关系。

放在 skills 包里是因为这里的每一条都是 skill 知识：
哪个内核事件算"开始/结束"、名字要剥哪些前缀、耗时怎么算、这个 skill 是不是自带上报。

上报走 `reporting.record()`：这一层只说"发生了一次 skill 调用"，
**不说发给谁** —— 那是路由表的事，将来一个 cowork 的数据可能要发给几个平台。
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING

from ctx_weft.core.events.types import Event, EventType

from netlivecowork.reporting.record import record

from .. import current_user
from .reporting import (
    consume_skill_own_reporting,
    discard_session_reporting,
    discard_task_reporting,
    normalize_skill_name as _normalize_skill_name,
)

if TYPE_CHECKING:
    from netlivecowork.api.models.session import SessionEntry

logger = logging.getLogger(__name__)

#: 记录类型。出口由路由表决定，这里不写。
KIND = "skill_usage"

# 全局 session 存储引用（通过 set_sessions_store 注入）
_sessions_store: "dict[str, SessionEntry] | None" = None


def _get_user_id_from_pwd() -> str:
    """转发：实现在出口那边（它是"上报怎么标识用户"的一部分）。"""
    from netlivecowork.reporting.sinks.datalink import _get_user_id_from_pwd as _impl
    return _impl()


def _session_user_pwd(session_id: str | None) -> tuple[str | None, str]:
    """返回 skill 任务执行期间使用的 PWD 及用户来源。"""
    username = ""
    workspace = ""

    if _sessions_store is not None and session_id:
        session_entry = _sessions_store.get(session_id)
        if session_entry is not None:
            user_info = getattr(session_entry, "user_info", None)
            workspace = str(getattr(session_entry, "workspace", None) or "").strip()
            if isinstance(user_info, dict):
                username = str(user_info.get("username") or "").strip()

    source = "session"
    if not username:
        # SessionEntry 是内存态：进程重启恢复的旧会话没有 user_info；桌面端是单用户
        # 进程，登录后已通过 /skills/current-user 注入当前活动用户名，恢复/HITL 链路
        # 按实际执行时已登录的用户归属。
        username = current_user.get_current_username().strip()
        source = "current-user"

    if not username:
        return None, "PWD"

    # workspace 允许为空。保留 user_<name>/ 这一既有格式，让最终 user_id 仍统一由
    # _get_user_id_from_pwd() 提取，而不是绕开 PWD 口径直接塞入载荷。
    return f"user_{username}/{workspace}", source


# =============================================================================
# Session Store 注入
# =============================================================================

def set_sessions_store(store: dict[str, SessionEntry] | None) -> None:
    global _sessions_store
    _sessions_store = store
    logger.info(
        "SkillReporter: set_sessions_store called, store size=%s",
        len(store) if store else 0,
    )


# =============================================================================
# SkillReporter 主类
# =============================================================================

_TASK_TERMINAL_EVENTS = frozenset(
    {
        EventType.TASK_FINISHED,
        EventType.TASK_FAILED,
        EventType.TASK_CANCELED,
        EventType.TASK_FINALIZED,
    }
)


class SkillReporter:
    """Subscribes to task/capability events and reports skill usage."""

    def __init__(self) -> None:
        # task_id -> {skill_name, start_time, session_id, user_id?}
        self._task_start_time: dict[str, dict] = {}
        self._managed_pwd: str | None = None
        self._pwd_before_managed: str | None = None
        self._pwd_before_managed_present = False

    async def on_event(self, event: Event) -> None:
        if event.type == EventType.TASK_CREATED:
            try:
                self._handle_task_created(event)
            except Exception:
                logger.exception(
                    "SkillReporter: failed to handle TASK_CREATED %s", event.id
                )
            return

        if event.type == EventType.TASK_STARTED:
            try:
                self._handle_task_started(event)
            except Exception:
                logger.exception(
                    "SkillReporter: failed to handle TASK_STARTED %s", event.id
                )
            return

        if event.type == EventType.CAPABILITY_FINISHED:
            try:
                await self._handle_capability_finished(event)
            except Exception:
                logger.exception(
                    "SkillReporter: failed to handle CAPABILITY_FINISHED %s", event.id
                )
            return

        if event.type in _TASK_TERMINAL_EVENTS:
            self._cleanup_terminal_task(event)
            return

        if event.type == EventType.SESSION_FINISHED:
            self._cleanup_finished_session(event.session_id)
            return



    def _cleanup_terminal_task(self, event: Event) -> None:
        task_id = str(event.task_id or "")
        if not task_id:
            task_data = event.payload.get("task", {})
            if isinstance(task_data, dict):
                task_id = str(task_data.get("id") or "")
        if task_id:
            self._task_start_time.pop(task_id, None)
            discard_task_reporting(event.session_id, task_id)

    def _cleanup_finished_session(self, session_id: str) -> None:
        stale_task_ids = [
            task_id
            for task_id, task_info in self._task_start_time.items()
            if task_info.get("session_id") == session_id
        ]
        for task_id in stale_task_ids:
            self._task_start_time.pop(task_id, None)
        discard_session_reporting(session_id)

    def _handle_task_created(self, event: Event) -> None:
        """TASK_CREATED: 记录 skill 开始执行时间。"""
        p = event.payload
        task_data: dict = p.get("task", {})
        task_id: str = task_data.get("id") or ""
        if not task_id:
            return

        settings = task_data.get("settings")
        skill_name: str | None = None
        if settings is not None:
            if isinstance(settings, dict):
                skill_name = settings.get("skill_name") or None
            else:
                skill_name = getattr(settings, "skill_name", None) or None

        if not skill_name:
            logger.info("SkillReporter TASK_CREATED: skill_name is empty, skip")
            return

        self._task_start_time[task_id] = {
            "skill_name": skill_name,
            "start_time": time.monotonic(),
            "session_id": event.session_id,
        }
        logger.info(
            "SkillReporter TASK_CREATED: task_id=%s, skill_name=%s, start_time=%s",
            task_id, skill_name, self._task_start_time[task_id]["start_time"],
        )

    def _clear_managed_pwd(self) -> None:
        """只恢复由本 Reporter 写入的 PWD，不覆盖其他代码的后续修改。"""
        managed_pwd = self._managed_pwd
        if managed_pwd is None:
            return

        if os.environ.get("PWD") == managed_pwd:
            if self._pwd_before_managed_present:
                os.environ["PWD"] = self._pwd_before_managed or ""
            else:
                os.environ.pop("PWD", None)

        self._managed_pwd = None
        self._pwd_before_managed = None
        self._pwd_before_managed_present = False

    def _set_managed_pwd(self, pwd: str) -> None:
        """设置当前 skill 任务的 PWD，并保存设置前的环境状态。"""
        self._clear_managed_pwd()
        self._pwd_before_managed_present = "PWD" in os.environ
        self._pwd_before_managed = os.environ.get("PWD")
        os.environ["PWD"] = pwd
        self._managed_pwd = pwd

    def _handle_task_started(self, event: Event) -> None:
        """TASK_STARTED: 清理上一任务的 PWD，并为当前 skill 任务设置用户上下文。"""
        # TASK_CREATED 仅表示入队；到 TASK_STARTED 才真正执行。无论当前任务是不是
        # skill，都先结束上一任务的 PWD 生命周期。
        self._clear_managed_pwd()

        task_id = str(event.task_id or "")
        task_info = self._task_start_time.get(task_id)
        if task_info is None:
            return

        report_pwd, user_source = _session_user_pwd(event.session_id)
        if report_pwd is None:
            logger.warning(
                "SkillReporter TASK_STARTED: no authenticated user context for "
                "session_id=%s; using ambient PWD/OLDPWD",
                event.session_id,
            )
        else:
            self._set_managed_pwd(report_pwd)
            logger.debug(
                "SkillReporter TASK_STARTED: prepared user PWD from %s for "
                "session_id=%s, task_id=%s",
                user_source,
                event.session_id,
                task_id,
            )

        # 保存任务自己的用户，避免下一任务启动并替换全局 PWD 后，上一任务完成上报
        # 时发生用户串号。
        task_info["user_id"] = _get_user_id_from_pwd()

    async def _handle_capability_finished(self, event: Event) -> None:
        """CAPABILITY_FINISHED: 计算耗时并上报 skill 执行详情。"""
        task_id: str = str(event.task_id or "")

        task_info = self._task_start_time.pop(task_id, None)
        if not task_info:
            return

        skill_name = task_info["skill_name"]
        start_time = task_info["start_time"]
        duration = round(max(0.0, time.monotonic() - start_time), 3)  # 保留3位小数

        # skill 名称（可能带 local_skill__ 或 cloud_skill__ 前缀）
        actual_skill_name = _normalize_skill_name(skill_name)
        if not actual_skill_name:
            logger.warning(
                "SkillReporter CAPABILITY_FINISHED: normalized skill_name is empty, "
                "original=%r",
                skill_name,
            )
            return

        # 云端 skill 的临时目录会在 provider 调用结束后删除；是否自带埋码已由
        # ReferencedSkillCapabilityProvider 在真实目录仍存在时捕获到任务级元数据。
        has_own_reporting = consume_skill_own_reporting(
            event.session_id,
            task_id,
            actual_skill_name,
        )

        if not has_own_reporting:
            # key 存在但值为空，表示 TASK_STARTED 时就没有可信用户；必须保留为空，
            # 不能读取下一任务后来写入的全局 PWD。只有兼容旧事件/直接调用、确实没经过
            # TASK_STARTED 时才从当前环境兜底。
            if "user_id" in task_info:
                resolved_user_id = str(task_info["user_id"] or "").strip()
            else:
                resolved_user_id = _get_user_id_from_pwd()
            # 只说"发生了一次 skill 调用"。发给谁、失败了怎么补发，都不是这一层的事：
            # 前者在路由表（将来一个 cowork 可能要发给几个平台），后者在出口的队列里。
            record(
                KIND,
                {
                    "function_name": actual_skill_name,
                    "duration": duration,
                    "user_id": resolved_user_id,
                    "ne_number": 0,
                },
                session_id=event.session_id,
            )
        else:
            logger.info(
                "SkillReporter CAPABILITY_FINISHED: skill %s has own reporting, skipped",
                skill_name,
            )