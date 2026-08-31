"""Datalink 出口 —— skill 用量上报去的那个云端服务。

**这里只管"把一条送出去"**：配置、AK/SK 签名、HTTP、重试退避、失败分类、发不出去时的
本地队列。它不认识 skill，也不认识"这条数据是怎么来的"。

从 `persistence/skill_reporter.py` 搬来。那个文件里塞着六件事，只有"内核事件 → 一次 skill
调用"那一件是 skill 的；其余五件是任何一种打点都要的，接第二个平台就得再抄一遍。
搬运是**逐行照搬**，行为一字未改——原有的 15 条测试是这次搬运唯一的依据。

⚠ **凭据是硬编码在源码里的**（`_get_datalink_config` 的那几个默认值），且随包发出去。
拿到仓库或 exe 的人就有了往那张表写数据的凭据。本次重构**照搬现状、不改凭据模型**，
但要记着这笔账：

  1. 先把 DATALINK_* 加进 env-reconcile 的 force 名单，老用户升级时自动补齐；
  2. 再去掉源码里的默认值（此时已经没人依赖它）；
  3. dev 与云端各自在自己的配置里补上。

顺序反了会断一批人：那三个键 2026-07-17 才进随包模板，**在那之前首装的用户，
今天完全靠源码里那个默认值在上报**（用户 .env 只在首启生成一次，且 DATALINK_* 不在
env-reconcile 的名单里，升级也补不上）。

更根本的问题补一句：客户端手里握着能往共享上报表写数据的凭据，意味着任何拿到 exe 的人
都能伪造上报。真正的解法是上报走服务端中转，客户端不持有写凭据——那是另一个改动。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
from base64 import b64encode
from pathlib import Path
from typing import Any

import httpx

from netlivecowork.providers.capability.skills.runtime.reporting import (
    normalize_skill_name as _normalize_skill_name,
)

from ..routing import Delivery
from .base import Sink

logger = logging.getLogger(__name__)

_DATALINK_MAX_ATTEMPTS = 3
_DATALINK_RETRY_DELAYS = (0.5, 1.5)
_DATALINK_RETRYABLE_STATUS_CODES = frozenset({408, 425, 429})
_DATALINK_RESPONSE_PREVIEW_LIMIT = 500
_DATALINK_RETRY_SPOOL_FILE = "skill-usage-retry.jsonl"
_DATALINK_DEAD_LETTER_FILE = "skill-usage-dead-letter.jsonl"
_DATALINK_RETRY_DRAIN_INTERVAL_SECONDS = 60.0

# HTTP 重试与队列重写不能与另一次事件派发并发进行。
_datalink_operation_lock = asyncio.Lock()
_datalink_spool_lock = threading.RLock()


# =============================================================================
# Datalink 配置（从环境变量读取）
# =============================================================================

def _get_datalink_config() -> dict[str, str]:
    """从环境变量获取 Datalink 配置。"""
    return {
        "aksk_id": os.getenv("DATALINK_AKSK_ID", "727e2b9c4f18410c8f58085a7f79953a"),
        "ak": os.getenv("DATALINK_AK", "B27262A46A3690BF45115021ACF97E88"),
        "sk": os.getenv("DATALINK_SK", "75730BD828972CC6ABF82199956D2BACB54CF8917E3EEACDDF374AEDBBD5984C"),
        "workspace_id": os.getenv("DATALINK_WORKSPACE_ID", "Dlink_2103041"),
        "app_id": os.getenv("DATALINK_APP_ID", "630431041"),
        "form_id": os.getenv("DATALINK_FORM_ID", "AFCE47F715974920BFC31CDE1D551D80"),
        "base_url": os.getenv("DATALINK_BASE_URL", "https://snic.gtsdata.huawei.com/datalinkprobackend/aksk/formentity/entityManagement"),
        "field_type": os.getenv("DATALINK_FIELD_TYPE", "5o0rpg"),
        "field_agent_name": os.getenv("DATALINK_FIELD_AGENT_NAME", "9nv4ob"),
        "field_agent_display_name": os.getenv("DATALINK_FIELD_AGENT_DISPLAY_NAME", "9145bit"),
        "field_function_name": os.getenv("DATALINK_FIELD_FUNCTION_NAME", "3obmt2"),
        "field_implementation": os.getenv("DATALINK_FIELD_IMPLEMENTATION", "3zbjoe"),
        "field_ne_number": os.getenv("DATALINK_FIELD_NE_NUMBER", "3qr7ot"),
        "field_user": os.getenv("DATALINK_FIELD_USER", "4oe7qp"),
        "field_project_name": os.getenv("DATALINK_FIELD_PROJECT_NAME", "1nwoo5"),
        "field_project_code": os.getenv("DATALINK_FIELD_PROJECT_CODE", "8omh33"),
        "field_time": os.getenv("DATALINK_FIELD_TIME", "5nxtyk"),
        "field_duration": os.getenv("DATALINK_FIELD_DURATION", "1ptgiy"),
        "field_task_id": os.getenv("DATALINK_FIELD_TASK_ID", "9qu2gv"),
    }


# =============================================================================
# Datalink API 调用
# =============================================================================

def _get_aksk_header() -> dict[str, str]:
    """生成 Datalink AK/SK 签名头。"""
    cfg = _get_datalink_config()
    timestamp = str(int(time.time() * 1000))
    aksk_data = (cfg["aksk_id"] + timestamp).encode("utf-8")
    hmac_str = hmac.new(
        cfg["sk"].encode("utf-8"), aksk_data, digestmod=hashlib.sha256
    ).hexdigest().upper()
    sign = ",".join([hmac_str, timestamp, cfg["ak"]])
    return {
        "Content-Type": "application/json;charset=utf-8",
        "Datalink-Sign": b64encode(sign.encode("utf-8")).decode("utf-8"),
    }


def _get_user_id_from_pwd() -> str:
    """从 PWD 环境变量中提取 user_id。"""
    # Windows 路径使用反斜杠；无工作目录时人工构造的 PWD 也可能恰好以
    # ``user_<name>`` 结束，因此分隔符和字符串末尾都必须视为合法边界。
    pattern = re.compile(r"(?:^|[\\/])user_([^\\/]+)(?=[\\/]|$)")
    for env_name in ("PWD", "OLDPWD"):
        value = (os.getenv(env_name) or "").strip()
        match = pattern.search(value)
        if match:
            return match.group(1).strip()
    return ""



async def _add_agent_invocation_detail(
    function_name: str,
    ne_number: int = 0,
    duration: float | None = None,
    *,
    user_id: str | None = None,
) -> dict[str, Any]:
    """调用 Datalink API 上报 skill 执行详情。

    Args:
        function_name: skill 名称
        ne_number: 网元数量，默认 0
        duration: skill 执行耗时（秒），可选
        user_id: 已按 PWD 口径解析的用户；未传时直接读取当前 PWD/OLDPWD

    Returns:
        API 响应 JSON
    """
    function_name = _normalize_skill_name(function_name)
    if not function_name:
        logger.warning("[Datalink] skill report skipped because skill_name is empty")
        return {
            "error": "skill_name is empty after prefix normalization",
            "error_type": "InvalidSkillName",
            "retryable": False,
            "queued": False,
        }

    cfg = _get_datalink_config()
    resolved_user_id = _get_user_id_from_pwd() if user_id is None else user_id.strip()
    agent_name = (
        os.getenv("element_name")
        or os.getenv("module_name")
        or os.getenv("project_name")
        or "On‑Prem CoWork"
    )
    agent_display_name = os.getenv("agent_display_name") or "CoWork"
    report_type = os.getenv("type", "个人")

    report_timestamp = str(int(time.time() * 1000))
    payload = {
        "workSpaceId": cfg["workspace_id"],
        "appId": cfg["app_id"],
        "formId": cfg["form_id"],
        "data": {
            "entityData": {
                cfg["field_type"]: report_type,
                cfg["field_agent_name"]: agent_name,
                cfg["field_agent_display_name"]: agent_display_name,
                cfg["field_function_name"]: function_name,
                cfg["field_ne_number"]: ne_number,
                cfg["field_implementation"]: "SKILL",
                cfg["field_user"]: resolved_user_id,
                cfg["field_project_name"]: "",
                cfg["field_project_code"]: "",
                cfg["field_time"]: report_timestamp,
                cfg["field_duration"]: duration,
                cfg["field_task_id"]: report_timestamp,
            }
        },
    }

    # 仅记录排障所需业务入参；AK、SK、Datalink-Sign 和原始 PWD 不进入日志。
    logger.info(
        "[Datalink] skill report request params: workspace_id=%s, app_id=%s, "
        "form_id=%s, type=%s, agent_name=%s, agent_display_name=%s, "
        "function_name=%s, user_id=%s, ne_number=%s, duration=%s, "
        "implementation=SKILL, report_timestamp=%s, task_id=%s",
        cfg["workspace_id"],
        cfg["app_id"],
        cfg["form_id"],
        report_type,
        agent_name,
        agent_display_name,
        function_name,
        resolved_user_id,
        ne_number,
        duration,
        report_timestamp,
        report_timestamp,
    )

    url = f"{cfg['base_url'].rstrip('/')}/saveEntity"
    async with _datalink_operation_lock:
        succeeded, result = await _post_datalink_payload(
            url=url,
            payload=payload,
            function_name=function_name,
        )
        if succeeded:
            return result

        queued = False
        if result.get("retryable", False):
            queued = _enqueue_pending_report(
                function_name=function_name,
                payload=payload,
            )
        return {**result, "queued": queued}

def _response_preview(response: httpx.Response) -> str:
    """Return a bounded single-line response excerpt without logging headers/signatures."""
    try:
        preview = response.text
    except Exception as exc:
        return f"<response body unavailable: {type(exc).__name__}: {exc}>"
    preview = preview.replace("\r", "\\r").replace("\n", "\\n")
    if len(preview) > _DATALINK_RESPONSE_PREVIEW_LIMIT:
        return preview[:_DATALINK_RESPONSE_PREVIEW_LIMIT] + "..."
    return preview


def _is_retryable_status(status_code: int) -> bool:
    return (
        status_code >= 500
        or status_code in _DATALINK_RETRYABLE_STATUS_CODES
    )


async def _retry_delay(attempt: int, *, function_name: str, reason: str) -> None:
    delay = _DATALINK_RETRY_DELAYS[attempt - 1]
    logger.warning(
        "[Datalink] skill report attempt %d/%d failed; retrying in %.1fs: "
        "function=%s, reason=%s",
        attempt,
        _DATALINK_MAX_ATTEMPTS,
        delay,
        function_name,
        reason,
    )
    await asyncio.sleep(delay)


async def _post_datalink_payload(
    *,
    url: str,
    payload: dict[str, Any],
    function_name: str,
) -> tuple[bool, dict[str, Any]]:
    """POST one report with bounded retries and diagnostic-safe logging."""
    try:
        async with httpx.AsyncClient(
            trust_env=False,
            verify=False,
            timeout=10.0,
        ) as client:
            for attempt in range(1, _DATALINK_MAX_ATTEMPTS + 1):
                try:
                    response = await client.post(
                        url,
                        headers=_get_aksk_header(),
                        json=payload,
                    )
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    reason = f"{type(exc).__name__}: {exc}"
                    if attempt < _DATALINK_MAX_ATTEMPTS:
                        await _retry_delay(
                            attempt,
                            function_name=function_name,
                            reason=reason,
                        )
                        continue
                    logger.warning(
                        "[Datalink] skill report failed after %d attempts: "
                        "function=%s, url=%s, error_type=%s, error=%s",
                        attempt,
                        function_name,
                        url,
                        type(exc).__name__,
                        exc,
                    )
                    return False, {
                        "error": str(exc),
                        "error_type": type(exc).__name__,
                        "attempts": attempt,
                        "retryable": True,
                    }

                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    status_code = response.status_code
                    content_type = response.headers.get("content-type", "")
                    preview = _response_preview(response)
                    reason = f"HTTP {status_code}"
                    if (
                        _is_retryable_status(status_code)
                        and attempt < _DATALINK_MAX_ATTEMPTS
                    ):
                        logger.warning(
                            "[Datalink] retryable HTTP response: function=%s, "
                            "url=%s, status=%d, content_type=%s, response=%r",
                            function_name,
                            url,
                            status_code,
                            content_type,
                            preview,
                        )
                        await _retry_delay(
                            attempt,
                            function_name=function_name,
                            reason=reason,
                        )
                        continue
                    logger.warning(
                        "[Datalink] skill report rejected: function=%s, url=%s, "
                        "status=%d, content_type=%s, response=%r, error=%s",
                        function_name,
                        url,
                        status_code,
                        content_type,
                        preview,
                        exc,
                    )
                    return False, {
                        "error": str(exc),
                        "error_type": type(exc).__name__,
                        "status_code": status_code,
                        "attempts": attempt,
                        "retryable": _is_retryable_status(status_code),
                    }

                try:
                    result = response.json()
                    if not isinstance(result, dict):
                        raise ValueError(
                            f"expected a JSON object, got {type(result).__name__}"
                        )
                except ValueError as exc:
                    content_type = response.headers.get("content-type", "")
                    preview = _response_preview(response)
                    reason = f"invalid JSON response: {type(exc).__name__}: {exc}"
                    logger.warning(
                        "[Datalink] invalid response body: function=%s, url=%s, "
                        "status=%d, content_type=%s, response=%r, error=%s",
                        function_name,
                        url,
                        response.status_code,
                        content_type,
                        preview,
                        exc,
                    )
                    if attempt < _DATALINK_MAX_ATTEMPTS:
                        await _retry_delay(
                            attempt,
                            function_name=function_name,
                            reason=reason,
                        )
                        continue
                    return False, {
                        "error": str(exc),
                        "error_type": type(exc).__name__,
                        "status_code": response.status_code,
                        "attempts": attempt,
                        "retryable": True,
                    }

                return True, result
    except Exception as exc:
        # Covers client construction/teardown and other unexpected failures.
        logger.exception(
            "[Datalink] unexpected skill report failure: function=%s, url=%s, "
            "error_type=%s, error=%s",
            function_name,
            url,
            type(exc).__name__,
            exc,
        )
        return False, {
            "error": str(exc),
            "error_type": type(exc).__name__,
            "attempts": 0,
            "retryable": True,
        }

    return False, {
        "error": "Datalink request ended without a response",
        "error_type": "UnexpectedState",
        "attempts": _DATALINK_MAX_ATTEMPTS,
        "retryable": True,
    }


def _retry_spool_path() -> Path:
    from netlivecowork.paths import data_dir

    return data_dir() / _DATALINK_RETRY_SPOOL_FILE


def _dead_letter_path() -> Path:
    from netlivecowork.paths import data_dir

    return data_dir() / _DATALINK_DEAD_LETTER_FILE


def _enqueue_pending_report(
    *,
    function_name: str,
    payload: dict[str, Any],
) -> bool:
    """Durably queue a failed report so a later event can retry it."""
    record = {
        "version": 1,
        "function_name": function_name,
        "queued_at": time.time(),
        "payload": payload,
    }
    path: Path | None = None
    try:
        path = _retry_spool_path()
        with _datalink_spool_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as spool:
                spool.write(json.dumps(record, ensure_ascii=False) + "\n")
        logger.warning(
            "[Datalink] skill report queued for retry: function=%s, spool=%s",
            function_name,
            path,
        )
        return True
    except Exception:
        logger.exception(
            "[Datalink] failed to persist retry record: function=%s, spool=%s",
            function_name,
            path or "<unresolved>",
        )
        return False


def _move_to_dead_letter(
    record: dict[str, Any],
    result: dict[str, Any],
) -> bool:
    """Retain permanently rejected records without blocking the retry queue."""
    path: Path | None = None
    try:
        path = _dead_letter_path()
        dead_letter = {
            **record,
            "failed_at": time.time(),
            "last_error": result,
        }
        with _datalink_spool_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as spool:
                spool.write(json.dumps(dead_letter, ensure_ascii=False) + "\n")
        return True
    except Exception:
        logger.exception(
            "[Datalink] failed to persist dead-letter record: function=%s, spool=%s",
            record.get("function_name", "<unknown>"),
            path or "<unresolved>",
        )
        return False


def _read_pending_reports() -> list[dict[str, Any]]:
    path = _retry_spool_path()
    if not path.exists():
        return []

    records: list[dict[str, Any]] = []
    malformed_record_found = False
    with _datalink_spool_lock:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []

    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict) or not isinstance(
                record.get("payload"), dict
            ):
                raise ValueError("retry record must contain an object payload")
            records.append(record)
        except ValueError as exc:
            malformed_record_found = True
            logger.warning(
                "[Datalink] ignoring malformed retry record: spool=%s, line=%d, "
                "error=%s, record=%r",
                path,
                line_number,
                exc,
                line[:_DATALINK_RESPONSE_PREVIEW_LIMIT],
            )
    if malformed_record_found:
        _write_pending_reports(records)
    return records


def _write_pending_reports(records: list[dict[str, Any]]) -> None:
    path = _retry_spool_path()
    with _datalink_spool_lock:
        if not records:
            path.unlink(missing_ok=True)
            return

        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(path.name + ".tmp")
        temp_path.write_text(
            "".join(
                json.dumps(record, ensure_ascii=False) + "\n"
                for record in records
            ),
            encoding="utf-8",
        )
        os.replace(temp_path, path)


async def _drain_pending_reports() -> int:
    """Retry durable records in order; retain the failed record and its tail."""
    async with _datalink_operation_lock:
        records = _read_pending_reports()
        if not records:
            return 0

        cfg = _get_datalink_config()
        url = f"{cfg['base_url'].rstrip('/')}/saveEntity"
        sent = 0
        removed = 0
        for index, record in enumerate(records):
            function_name = str(record.get("function_name") or "<unknown>")
            succeeded, result = await _post_datalink_payload(
                url=url,
                payload=record["payload"],
                function_name=function_name,
            )
            if not succeeded:
                if not result.get("retryable", False):
                    if not _move_to_dead_letter(record, result):
                        break
                    logger.error(
                        "[Datalink] permanently rejected queued report moved to "
                        "dead letter: function=%s, result=%s",
                        function_name,
                        result,
                    )
                    _write_pending_reports(records[index + 1 :])
                    removed += 1
                    continue
                logger.warning(
                    "[Datalink] retry spool drain paused: function=%s, "
                    "remaining=%d, result=%s",
                    function_name,
                    len(records) - index,
                    result,
                )
                break
            sent += 1
            removed += 1
            _write_pending_reports(records[index + 1 :])

        if sent:
            logger.info(
                "[Datalink] drained %d queued skill report(s); remaining=%d",
                sent,
                len(records) - removed,
            )
        return sent


# ── 出口 ──────────────────────────────────────────────────────────────────────


class DatalinkSink(Sink):
    """把一条 skill 用量送到 Datalink。

    **后端直发**那一类：用的是这个部署自己的 AK/SK，不需要用户令牌，所以后端自己就能发。
    （另一类是主进程代发，见 relay.py —— 那条路要用户令牌，而令牌只在主进程。）
    """

    name = "datalink"

    def __init__(self) -> None:
        self._drainer = _RetryDrainer()

    @property
    def drainer(self) -> "_RetryDrainer":
        return self._drainer

    def enqueue(self, delivery: Delivery) -> bool:
        """本出口是异步发送的，这里只把任务挂起来。**绝不抛。**

        发送结果不回传给调用方——**"发不出去怎么补发"是出口自己的事**。
        搬运前这段挂在 SkillReporter 上，等于让"什么算一次 skill 调用"那一层
        去操心重试队列。
        """
        p = delivery.payload
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 没有运行中的事件循环（同步上下文）。记日志而不是抛：打点不能影响业务，
            # 但也不能让它静默消失。
            logger.warning("[Datalink] 不在事件循环里，这条发不出去：%s", p.get("function_name"))
            return False

        # 每来一条就顺手看一眼积压——与搬运前 SkillReporter.on_event 每次都调
        # _schedule_retry_drain() 的时机一致。
        self._drainer.schedule()
        task = loop.create_task(
            _add_agent_invocation_detail(
                str(p.get("function_name") or ""),
                ne_number=int(p.get("ne_number") or 0),
                duration=p.get("duration"),
                user_id=p.get("user_id"),
            )
        )
        task.add_done_callback(self._after_send)
        return True

    def _after_send(self, task: "asyncio.Task[dict]") -> None:
        """发送结束后：失败且已入队 → 安排补发。与搬运前逐条对应。"""
        if task.cancelled():
            return
        try:
            result = task.result()
        except Exception:
            logger.exception("[Datalink] skill 用量上报任务异常")
            return
        if "error" not in result:
            logger.info("[Datalink] skill 用量已上报：%s", result)
            return
        logger.warning(
            "[Datalink] skill 用量上报失败，queued=%s，result=%s",
            result.get("queued", False), result,
        )
        if result.get("queued", False):
            self._drainer.schedule(delay_seconds=_DATALINK_RETRY_DRAIN_INTERVAL_SECONDS)

    async def close(self) -> None:
        await self._drainer.close()



# ── 重试队列的后台抽干 ────────────────────────────────────────────────────────
#
# 从 SkillReporter 原样搬来。它本来就是**出口的队列**在自我维护，跟 skill 没有关系：
# 挂在领域对象上，等于让"什么算一次 skill 调用"那一层去操心"发不出去的怎么补发"。


class _RetryDrainer:
    """发不出去的攒着，隔一阵子再试一轮。

    行为与搬运前一致：队列为空就不起任务；已有任务在跑就不重复起；
    一轮结束后隔 ``_DATALINK_RETRY_DRAIN_INTERVAL_SECONDS`` 再来一轮；close 后不再起。
    """

    def __init__(self) -> None:
        self._task: asyncio.Task[int] | None = None
        self._closed = False

    def schedule(self, *, delay_seconds: float = 0.0) -> None:
        if self._closed:
            return
        if self._task is not None and not self._task.done():
            return
        try:
            spool_path = _retry_spool_path()
            if not spool_path.exists() or spool_path.stat().st_size == 0:
                return
        except Exception:
            logger.exception("[Datalink] failed to inspect the skill retry spool")
            return
        # 先确认有循环再造协程：反过来的话，create_task 抛 RuntimeError 时那个协程
        # 已经建出来了却没人 await，会留下一个 "coroutine was never awaited" 的告警
        # 与一份泄漏。
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # 没有运行中的事件循环（同步上下文）。下一次有循环时再补。
            return
        self._task = asyncio.create_task(self._drain_after(delay_seconds))
        self._task.add_done_callback(self._done)

    @staticmethod
    async def _drain_after(delay_seconds: float) -> int:
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        return await _drain_pending_reports()

    def _done(self, task: "asyncio.Task[int]") -> None:
        self._task = None
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            logger.exception("[Datalink] unexpected retry spool drain failure")
        if not self._closed:
            self.schedule(delay_seconds=_DATALINK_RETRY_DRAIN_INTERVAL_SECONDS)

    async def close(self) -> None:
        """停掉后台补发任务（应用退出时）。"""
        self._closed = True
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def reopen(self) -> None:
        """只给测试用：close 之后还想接着用。"""
        self._closed = False


#: 进程内唯一的一个。lifecycle 退出时调它的 close()。
#: 放在文件末尾：它依赖上面的 _RetryDrainer，而那是从领域侧搬下来的、追加在后面的。
_SINK = DatalinkSink()


def sink() -> DatalinkSink:
    return _SINK
