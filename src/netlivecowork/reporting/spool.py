"""本地队列 —— 打点数据在发出去之前先落在这里。

**一份实现，两处用**：主进程代发那条路（Electron 来取）与后端直发那条路（后端自己抽干）
共用这一套语义。今天是两套：后端那套「重试文件 + 死信文件 + 定时清空」，
主进程那套「取走 → 落盘 → 确认」。**两套的丢数语义不同**，于是"这条数据到底丢没丢"
要先问"它走了哪条路"。这里保留后者——它更严谨。

取走-确认（claim/ack）为什么比"取走即删"好：

    取走即删     后端把批次交出去 → 主进程还没落盘就崩了 → 这批没了
    取走-确认    重命名后的批次在**确认之前一直保留**，崩了下次照样取到

⚠ **格式与文件名不能改**：主进程正在读 ``telemetry-spool.jsonl`` /
``token-usage-spool.jsonl``，一行一个 JSON 对象。改了那边就得跟着改，而两边不是一起发布的。

⚠ **每次 open-append-close，不持长 fd**：主进程用 rename 接管文件，
Windows 上 rename 一个打开中的文件会失败。
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

#: 进程内唯一的一把锁：追加与"重命名接管"必须互斥，否则会取走半行。
#: **全进程只能有这一把** —— observability/events.py 与 api/spool.py 都用它。
#: 两把锁的失效方式是偶发的半行 JSON，量小时几乎撞不到，上线后才出现。
_lock = threading.RLock()


def spool_lock() -> threading.RLock:
    return _lock


def _data_dir() -> Path:
    from netlivecowork.paths import data_dir
    return data_dir()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── 写 ────────────────────────────────────────────────────────────────────────

def append(spool_file: str, event_type: str, fields: dict) -> bool:
    """追加一条。**任何异常都吞掉** —— 打点绝不能影响业务（需求 T1）。

    写出的形状与历史一致：``{event_type, ts, **fields}``，一行一个 JSON。
    返回是否真的写成了，仅供调用方记日志/计数，**不要据此抛错**。
    """
    try:
        with _lock:
            path = _data_dir() / spool_file
            path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(
                {"event_type": event_type, "ts": _now_iso(), **fields},
                ensure_ascii=False,
                default=str,
            )
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True
    except Exception:
        return False


# ── 读 ────────────────────────────────────────────────────────────────────────

def _parse(content: bytes) -> list[dict]:
    """坏行跳过而不是整批丢。

    一行写坏（磁盘满、进程被杀在半行）不该连累同批次的其它行——那才是真正的丢数。
    """
    out: list[dict] = []
    for line in content.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _draining_path(spool_file: str) -> tuple[Path, Path]:
    path = _data_dir() / spool_file
    return path, path.with_name(path.name + ".draining")


def claim(spool_file: str) -> dict:
    """取走一批但**不删**，删除由 ack 负责。

    并发追加会落到 rename 之后新建的同名文件里，属于下一批——不会混进这一批。
    """
    path, draining = _draining_path(spool_file)
    try:
        with _lock:
            if not draining.exists():
                if not path.exists():
                    return {"claimId": None, "events": []}
                path.rename(draining)
            content = draining.read_bytes()
            return {
                "claimId": hashlib.sha256(content).hexdigest(),
                "events": _parse(content),
            }
    except OSError:
        logger.exception("claim spool file %s failed", spool_file)
        return {"claimId": None, "events": []}


def ack(spool_file: str, claim_id: str) -> bool:
    """只删掉**正是那一批**。已删之后重复 ack 返回 True（幂等）。

    对不上就拒绝：说明这批不是调用方拿到的那批（比如它崩溃后又攒了新的），
    删掉等于丢数。
    """
    path, draining = _draining_path(spool_file)
    try:
        with _lock:
            if not draining.exists():
                return True
            content = draining.read_bytes()
            if hashlib.sha256(content).hexdigest() != claim_id:
                return False
            draining.unlink()
            return True
    except OSError:
        logger.exception("ack spool file %s claim %s failed", spool_file, claim_id)
        return False


def drain(spool_file: str) -> list[dict]:
    """取走并立即删除。**取走后崩溃这批就没了** —— 留着是为兼容旧版主进程，
    新代码一律用 claim/ack。
    """
    path, draining = _draining_path(spool_file)
    try:
        with _lock:
            if not draining.exists():
                if not path.exists():
                    return []
                path.rename(draining)
            events = _parse(draining.read_bytes())
            draining.unlink()
            return events
    except OSError:
        logger.exception("drain spool file %s failed", spool_file)
        return []
