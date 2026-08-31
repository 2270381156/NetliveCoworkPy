"""把导出的会话 SQLite 导入回实时后端：所有 id 重映射为统一 imp_ 前缀
（列与 JSON 一致重写），按 FK 安全序灌进实时 DB。session_export.py 的镜像。

契约见 docs/superpowers/specs/2026-06-29-session-db-import-design.md。
"""
from __future__ import annotations

import asyncio
import gzip
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as OrmSession
from ulid import ULID

from ctx_weft.core.utils import generate_id
from netlivecowork.persistence.postgres.models import (
    SessionModel, TaskModel, EventModel, MemoryEventModel,
    MemorySubscriptionModel, SessionSSEEventModel, SnapshotModel,
)


class InvalidSessionDumpError(Exception):
    """上传文件不是可读的会话 SQLite dump → 路由层转 400。"""


# FK 安全插入序：sessions 先（tasks/snapshots 有 FK → sessions）。
_MODELS_ORDER = [
    SessionModel, TaskModel, EventModel, MemoryEventModel,
    MemorySubscriptionModel, SessionSSEEventModel, SnapshotModel,
]

# 每张表里需重映射的 id 型列。
_ID_COLUMNS = {
    "sessions": ["id", "root_agent_id"],
    "tasks": ["id", "session_id", "assigned_agent_id", "creator_agent_id"],
    "events": ["id", "run_id", "session_id", "task_id", "agent_id", "causation_id"],
    "memory_events": ["id", "session_id", "task_id", "agent_id"],
    "memory_subscriptions": ["id", "session_id", "task_id"],
    "session_sse_events": ["session_id"],   # id 是自增主键，插入时丢弃
    "snapshots": ["id", "session_id", "last_event_id"],
}

# 可能内嵌 id 的 JSON/Text 列，递归重写。
_JSON_COLUMNS = {
    "sessions": ["config_json"],
    "tasks": ["outputs_json"],
    "events": ["payload_json", "metadata_json"],
    "memory_events": ["content", "metadata_json"],
    "session_sse_events": ["event_json"],
    "snapshots": ["state_blob_json"],
}


def _build_id_map(collected: dict) -> dict:
    """扫描所有 id 型列，重映射为新 id：事件保序、其余统一 imp_ 前缀。

    events 的 id 序 = 时间序是全库不变量（read_by_session/read_after/迁移判据全按
    ORDER BY id 回放与比位点），重映射必须保序——否则导入会话的事件流被洗牌，
    fold/恢复/回填全错。事件新 id = ``evt_`` + 按原事件 timestamp 重建的 ULID
    （按旧 id 序分配、同微秒或乱源时强制单调递增），用 evt_ 前缀与续跑追加的新事件
    同前缀可比、时间轴自然衔接（imp_ 前缀会让新事件整体排到导入历史之前）。
    非事件 id 无排序语义，维持 imp_<rand>（导入身份由 session id 前缀 + imported_from 承载）。
    """
    ids: set = set()
    for table, cols in _ID_COLUMNS.items():
        for row in collected.get(table, []):
            for c in cols:
                v = row.get(c)
                if v:
                    ids.add(v)

    id_map: dict = {}
    last: ULID | None = None
    # 旧 id 字典序 = 原始时间序（原生 ULID）；来源本身已乱的旧 dump 也以此为唯一真相。
    for row in sorted(collected.get("events", []), key=lambda r: str(r.get("id") or "")):
        old = row.get("id")
        if not old or old in id_map:
            continue
        ts = row.get("timestamp")
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)  # 库里 naive 即 UTC,勿按本地时区解释
            candidate = ULID.from_datetime(ts)
        else:
            candidate = ULID()
        if last is not None and str(candidate) <= str(last):
            candidate = ULID.from_int(int(last) + 1)
        id_map[old] = f"evt_{candidate}"
        last = candidate

    for old in ids:
        if old not in id_map:
            id_map[old] = generate_id("imp")
    return id_map


def _rewrite_obj(o, id_map: dict):
    """递归把等于某原始 id 的字符串值/键替换为新 id。"""
    if isinstance(o, str):
        return id_map.get(o, o)
    if isinstance(o, list):
        return [_rewrite_obj(x, id_map) for x in o]
    if isinstance(o, dict):
        return {id_map.get(k, k): _rewrite_obj(v, id_map) for k, v in o.items()}
    return o


def _rewrite_json_text(text, id_map: dict):
    """对 JSON 文本做精确值替换；非 JSON / None 原样返回。"""
    if not isinstance(text, str):
        return text
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        return text
    return json.dumps(_rewrite_obj(obj, id_map), ensure_ascii=False)


def _rewrite_rows(collected: dict, id_map: dict) -> None:
    """原地重写 collected：列按 map 改，JSON 列递归改，sse 自增 id 丢弃。"""
    for table, rows in collected.items():
        idcols = _ID_COLUMNS.get(table, [])
        jcols = _JSON_COLUMNS.get(table, [])
        for row in rows:
            for c in idcols:
                if row.get(c) in id_map:
                    row[c] = id_map[row[c]]
            for c in jcols:
                if row.get(c) is not None:
                    row[c] = _rewrite_json_text(row[c], id_map)
            if table == "session_sse_events":
                row.pop("id", None)


def _read_dump(data: bytes) -> dict:
    """同步读 dump 的 7 张表为 {tablename: [col dict]}（类型经 ORM 保真）。

    export_session_db 现在整包 gzip；按 magic (\\x1f\\x8b) 嗅探透明解压，
    旧的未压缩 dump 仍原样处理（向后兼容）。
    """
    if data[:2] == b"\x1f\x8b":
        try:
            data = gzip.decompress(data)
        except (OSError, EOFError) as e:
            raise InvalidSessionDumpError(f"corrupt gzip dump: {e}") from e
    fd, tmp = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    Path(tmp).write_bytes(data)
    try:
        engine = create_engine(f"sqlite:///{Path(tmp).as_posix()}")
        try:
            collected: dict = {}
            with OrmSession(engine) as s:
                for model in _MODELS_ORDER:
                    # 按主键 id 升序读：session_sse_events 的自增 id 即插入顺序,
                    # 回放依赖该顺序（spec §3.1.4）；其余表 id 为 ULID,排序也确定。
                    objs = s.execute(
                        select(model).order_by(model.__table__.c.id)
                    ).scalars().all()
                    cols = [c.name for c in model.__table__.columns]
                    collected[model.__tablename__] = [
                        {n: getattr(o, n) for n in cols} for o in objs
                    ]
        except SQLAlchemyError as e:
            raise InvalidSessionDumpError(f"unreadable session dump: {e}") from e
        finally:
            engine.dispose()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not collected.get("sessions"):
        raise InvalidSessionDumpError("dump has no session row")
    return collected


async def _insert_rows(collected: dict, factory) -> None:
    async with factory() as db:
        async with db.begin():
            for model in _MODELS_ORDER:
                rows = collected.get(model.__tablename__) or []
                if rows:
                    await db.execute(model.__table__.insert(), rows)


def _canonicalize_template_ids(collected: dict) -> None:
    """升级前导出的旧 dump 载荷里是裸 template_id；m010 已打标不会重跑，导入路径须
    自行按同口径规范化，否则导入会话的引擎重放（崩溃恢复/冷 HITL/compact）报
    TemplateNotFoundError。覆盖 events.payload_json 顶层键、snapshots.state_blob_json
    的 sessions.*.template_id、sessions.config_json 顶层键。幂等：已含 ':' / 空值跳过。"""
    from netlivecowork.providers.templates import canonical_template_id

    def _canon(tid):
        return canonical_template_id(tid) if isinstance(tid, str) and tid else tid

    def _rewrite_top_key(rows: list, col: str) -> None:
        for row in rows:
            raw = row.get(col)
            if not isinstance(raw, str) or '"template_id"' not in raw:
                continue
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            tid = obj.get("template_id")
            new = _canon(tid)
            if new != tid:
                obj["template_id"] = new
                row[col] = json.dumps(obj, ensure_ascii=False)

    _rewrite_top_key(collected.get("events", []), "payload_json")
    _rewrite_top_key(collected.get("sessions", []), "config_json")

    for row in collected.get("snapshots", []):
        raw = row.get("state_blob_json")
        if not isinstance(raw, str) or '"template_id"' not in raw:
            continue
        try:
            state = json.loads(raw)
        except ValueError:
            continue
        dirty = False
        for sess in (state.get("sessions") or {}).values():
            tid = sess.get("template_id")
            new = _canon(tid)
            if new != tid:
                sess["template_id"] = new
                dirty = True
        if dirty:
            row["state_blob_json"] = json.dumps(state, ensure_ascii=False)


async def import_session_db(sqlite_bytes: bytes, factory) -> str:
    """导入一个会话 dump 到实时 DB，所有 id 重映射为 imp_ 前缀，返回新 session id。

    文件损坏 / 无 sessions 行 → InvalidSessionDumpError（路由转 400）。
    """
    collected = await asyncio.to_thread(_read_dump, sqlite_bytes)
    original_sid = collected["sessions"][0]["id"]
    id_map = _build_id_map(collected)
    _rewrite_rows(collected, id_map)
    _canonicalize_template_ids(collected)
    new_sid = id_map[original_sid]
    # 溯源：原始 session id 写进重写后的 config_json（重写已把内嵌的旧 id 换掉，
    # 故 imported_from 须在重写之后落原始值）。
    srow = collected["sessions"][0]
    try:
        cfg = json.loads(srow.get("config_json") or "{}")
    except (TypeError, ValueError):
        cfg = {}
    cfg["imported_from"] = original_sid
    srow["config_json"] = json.dumps(cfg, ensure_ascii=False)
    await _insert_rows(collected, factory)
    return new_sid
