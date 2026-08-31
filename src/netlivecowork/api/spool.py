"""本地 spool 文件的排空端点，供 Electron 主进程拉取。

Electron 之前是自己拼 %APPDATA%\\...\\data 路径直接读文件系统,只有它自己 spawn 打包后端时
才会把 NLC_DATA_DIR 设成这个值;源码直跑 / 复用已运行后端时两边对 data_dir 的认知会对不上,
导致 Electron 永远读不到 spool 文件(见 netcowork/doc/TOKEN_USAGE_REPORTING_CHANGELOG.md)。
改成让 Electron 直接问后端要数据,后端用自己实际生效的 data_dir() 排空,彻底消除"两边独立猜
同一个路径"这个错位来源。

新版 token 用量通道使用 claim → Electron 原子落 retry → ack：rename 后的 .draining 在 ack
之前一直保留，避免 Electron 收到批次但尚未来得及持久化就崩溃造成丢数。旧 drain 端点继续保留
兼容源码开发时复用的旧 Electron。并发 append 会落到 rename 后新建的同名文件里，属于下一批。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from netlivecowork.reporting import spool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


# ── 队列实现在 reporting/spool.py，这里只转发 ────────────────────────────────
#
# 曾经这里有一份完整的取走/确认/解析实现，与 reporting 那份并存。两份的失效方式很难查：
# 一边改了另一边没改，表现是"主进程偶尔取不到数据"，而两边各自的测试都是绿的。

def drain_spool_file(spool_file: str) -> list[dict]:
    return spool.drain(spool_file)


def claim_spool_file(spool_file: str) -> dict:
    return spool.claim(spool_file)


def ack_spool_claim(spool_file: str, claim_id: str) -> bool:
    return spool.ack(spool_file, claim_id)


@router.get("/token-usage-spool")
def drain_token_usage_spool() -> list[dict]:
    """排空 token-usage-spool.jsonl,返回待上报事件;调用后这批事件即从本地磁盘清除。"""
    return drain_spool_file("token-usage-spool.jsonl")


@router.get("/token-usage-spool/claim")
def claim_token_usage_spool() -> dict:
    """Claim a durable batch. The .draining file remains until the matching ack."""
    return claim_spool_file("token-usage-spool.jsonl")


@router.delete("/token-usage-spool/claim/{claim_id}")
def ack_token_usage_spool(claim_id: str) -> dict:
    if not ack_spool_claim("token-usage-spool.jsonl", claim_id):
        raise HTTPException(status_code=409, detail="token-usage spool claim mismatch")
    return {"acked": True}


# ── 实时通知：让 Electron 不用每 30 秒轮询,而是"有新用量就立刻来 drain" ──────────
#
# spool 文件本身仍然是唯一的数据来源(durable),这里只是加一条"有新数据了"的低延迟
# 提醒通道——SSE 消息本身不携带数据,Electron 收到提醒后照样调用上面 GET
# /token-usage-spool 把真正的数据取走。这样即使 Electron 暂时没连上这个提醒流(比如
# 刚启动、或连接掉线重连中),数据也只是攒在 spool 文件里、不会丢,等 Electron 那边低频
# 兜底定时器(见 electron/main.js)触发时照样能拿到。
#
# 用 asyncio.Queue 而不是照搬 session.py 的 sse_generator/Condition 那一套,是因为这里
# 不需要历史回放、不需要给每条事件编号——纯粹是"叫醒对方"的一声铃,用最简单的广播原语够用。
_token_usage_waiters: set[asyncio.Queue] = set()


def notify_token_usage() -> None:
    """report_token_usage() 每次成功捕获一条用量后调用一次,唤醒所有正在监听的 SSE 客户端。"""
    for q in list(_token_usage_waiters):
        try:
            q.put_nowait(None)
        except Exception:
            pass


@router.get("/token-usage-stream")
async def token_usage_stream(request: Request) -> StreamingResponse:
    """SSE 提醒流:每次有新的 token 用量事件产生就推一条空消息,不带数据。"""

    async def gen():
        queue: asyncio.Queue = asyncio.Queue()
        _token_usage_waiters.add(queue)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    await asyncio.wait_for(queue.get(), timeout=15)
                    yield "data: usage\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # 心跳,防止中间代理/连接因空闲被判定断开
        finally:
            _token_usage_waiters.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
