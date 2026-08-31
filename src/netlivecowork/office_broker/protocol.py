"""Low 客户端 ↔ Medium broker 的线协议：4 字节长度前缀 + UTF-8 JSON。纯逻辑，跨平台可测。

用长度前缀而不是管道的 message 模式：客户端那侧是普通 open() 读文件句柄，byte 流最省事；
且长度前缀让"半包/粘包"没有歧义。单请求单响应、严格串行（COM 那侧是 STA 单线程，本来也不
支持并发调用）。
"""

from __future__ import annotations

import json
import struct

MAX_FRAME = 8 * 1024 * 1024   # 单帧上限：Office 传回的值都是标量/小数组，8MB 足够且防内存炸

_HEADER = struct.Struct(">I")


class ProtocolError(RuntimeError):
    pass


def encode(msg: dict) -> bytes:
    body = json.dumps(msg, ensure_ascii=False, default=str).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise ProtocolError(f"帧过大：{len(body)} > {MAX_FRAME}")
    return _HEADER.pack(len(body)) + body


def decode(body: bytes) -> dict:
    try:
        msg = json.loads(body.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise ProtocolError(f"帧不是合法 JSON：{e}") from e
    if not isinstance(msg, dict):
        raise ProtocolError("帧必须是 JSON 对象")
    return msg


def read_frame(read_exactly) -> dict | None:
    """用 `read_exactly(n) -> bytes` 读一帧；对端关闭返回 None。"""
    head = read_exactly(_HEADER.size)
    if not head or len(head) < _HEADER.size:
        return None
    (n,) = _HEADER.unpack(head)
    if n > MAX_FRAME:
        raise ProtocolError(f"帧长越界：{n}")
    body = read_exactly(n) if n else b""
    if len(body) < n:
        return None
    return decode(body)


# ── 值编码 ────────────────────────────────────────────────────────────────
# COM 对象不能进 JSON，用 {"__ref__": id} 指代 broker 对象表里的条目；其余走 {"__v__": ...}。

def ref(obj_id: int) -> dict:
    return {"__ref__": obj_id}


# 值类型标记。JSON 只有标量，datetime / bytes / Decimal 这些没有对应形式，以前一律 str() 兜底——
# 后果是**静默类型漂移**：半自动（直连 win32com）拿到的 appt.Start 是 datetime，全自动拿到的是
# 字符串 '2026-08-26 09:00:00+08:00'，`.strftime()` / `>= today` 全都失败，而且不报"类型不对"，
# 只报一句莫名其妙的 AttributeError。所以特殊类型必须显式带着类型过管道，两侧各自还原。
KIND_DATETIME = "dt"
KIND_DATE = "d"
KIND_TIME = "t"
KIND_BYTES = "b64"
KIND_DECIMAL = "dec"


def val(v, kind: str | None = None) -> dict:
    return {"__v__": v} if kind is None else {"__v__": v, "__t__": kind}


def encode_special(v):
    """python 值 → 带类型标记的 val；不是特殊类型返回 None（由调用方按普通值处理）。"""
    import base64
    import datetime
    from decimal import Decimal

    if isinstance(v, datetime.datetime):
        return val(v.isoformat(), KIND_DATETIME)
    if isinstance(v, datetime.date):
        return val(v.isoformat(), KIND_DATE)
    if isinstance(v, datetime.time):
        return val(v.isoformat(), KIND_TIME)
    if isinstance(v, (bytes, bytearray)):
        return val(base64.b64encode(bytes(v)).decode("ascii"), KIND_BYTES)
    if isinstance(v, Decimal):
        return val(str(v), KIND_DECIMAL)
    return None


def decode_special(x):
    """带类型标记的 val → python 值。没有标记 / 认不出的标记 → 原样返回 __v__。

    认不出就原样给：协议两侧版本不齐时，宁可退化成字符串，也不该整条调用失败。
    """
    import base64
    import datetime
    from decimal import Decimal

    if not (isinstance(x, dict) and "__v__" in x):
        return x
    raw, kind = x["__v__"], x.get("__t__")
    try:
        if kind == KIND_DATETIME:
            return datetime.datetime.fromisoformat(raw)
        if kind == KIND_DATE:
            return datetime.date.fromisoformat(raw)
        if kind == KIND_TIME:
            return datetime.time.fromisoformat(raw)
        if kind == KIND_BYTES:
            return base64.b64decode(raw)
        if kind == KIND_DECIMAL:
            return Decimal(raw)
    except Exception:      # noqa: BLE001 — 解码失败退化成原始值，别让一次调用整个崩掉
        return raw
    return raw


def is_ref(x) -> bool:
    return isinstance(x, dict) and "__ref__" in x


def is_val(x) -> bool:
    return isinstance(x, dict) and "__v__" in x


def ok(payload: dict) -> dict:
    return {"ok": True, **payload}


def err(code: str, message: str) -> dict:
    return {"ok": False, "code": code, "message": message}
