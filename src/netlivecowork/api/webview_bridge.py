"""应用内浏览器「现取现回」桥（方案 B）。

后端 tool 在 host 里执行，但网页正文只有前端 webview 拿得到。本桥负责一次 round-trip：

    tool.invoke → request_content(session_id)
        · 往该会话的 SSE 流推一条 webview_content_request（带 request_id）
        · await 一个以 request_id 为键的 future（带超时）
    前端 SSE 收到 → 抓取 webview 内容 → POST /sessions/{id}/webview-content
        · 端点调 resolve(request_id, content) → future 完成 → tool 拿到内容

超时（前端未响应 / 没开网页 / 后台会话 SSE 未连）→ 返回 None，tool 据此回「读不到」。
webview_content_request 是瞬时控制事件，已加入 SessionEntry._NO_PERSIST，不落库、不 replay。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

REQUEST_EVENT_TYPE = "webview_content_request"

# request_id → 等待前端回传的 future。仅存活于单次请求生命周期。
_pending: dict[str, asyncio.Future] = {}


async def request_content(session_id: str, *, timeout: float = 8.0) -> dict[str, Any] | None:
    """向前端请求「当前右侧网页」内容。超时或无会话 → None。"""
    # 延迟 import 避免与 session 注册表的循环依赖。
    from netlivecowork.api.models import session as _sm

    entry = _sm._sessions.get(session_id)
    if entry is None:
        return None

    request_id = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending[request_id] = fut
    try:
        await entry._append_json(json.dumps({
            "type": REQUEST_EVENT_TYPE,
            "request_id": request_id,
        }))
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        logger.info("webview_bridge: request %s timed out (session %s)", request_id, session_id)
        return None
    except Exception:
        logger.exception("webview_bridge: request %s failed (session %s)", request_id, session_id)
        return None
    finally:
        _pending.pop(request_id, None)


def resolve(request_id: str, content: dict[str, Any]) -> bool:
    """前端回传时调用：完成对应 future。找不到（已超时清理）→ False（no-op）。"""
    fut = _pending.get(request_id)
    if fut is not None and not fut.done():
        fut.set_result(content)
        return True
    return False
