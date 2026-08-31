"""host template_id 全链 canonical 化（spec 2026-07-22 host-canonical-template-id-display）。

_entry_from_record：存量裸行载入即规范；session_import：旧 dump 载荷落库前规范化
（m010 已打标不重跑，导入路径须自行补）。
"""

from __future__ import annotations

import gzip
import json
from types import SimpleNamespace

from netlivecowork.api.models.session import _entry_from_record
from netlivecowork.observability.session_import import import_session_db
from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import (
    Base, EventModel, SessionModel, SnapshotModel,
)


# ── _entry_from_record ───────────────────────────────────────────────────────

def _rec(template_id):
    return SimpleNamespace(
        id="ses_1", config={"template_id": template_id}, user_prompt="hi",
        tenant_id="default", llm_model="m", llm_provider="acc", status="FINISHED",
        goal=None, root_agent_id="agt_1", token_budget=0, failure_counter=0,
        workspace=None, created_at=None, updated_at=None,
    )


def test_entry_from_record_prefixes_bare_template_id():
    assert _entry_from_record(_rec("default")).template_id == "agent:default"


def test_entry_from_record_canonical_passthrough_and_empty():
    assert _entry_from_record(_rec("agent:default")).template_id == "agent:default"
    assert _entry_from_record(_rec("")).template_id == ""  # 空值不得变成 "agent:"


# ── session_import ───────────────────────────────────────────────────────────

def _make_dump(tmp_path) -> bytes:
    """最小旧版会话 dump：用真实模型建表（_read_dump 按 ORM 全列读，手写 DDL 会缺列），
    sessions/events/snapshots 三表带裸 template_id 载荷。"""
    from sqlalchemy import create_engine, insert

    db = tmp_path / "dump.sqlite"
    engine = create_engine(f"sqlite:///{db.as_posix()}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(insert(SessionModel.__table__).values(
            id="ses_old", user_prompt="hi", status="FINISHED", tenant_id="default",
            config_json=json.dumps({"template_id": "default"}),
        ))
        conn.execute(insert(EventModel.__table__).values(
            id="evt_01AAAAAAAAAAAAAAAAAAAAAAAA", session_id="ses_old", tenant_id="default",
            type="SESSION_CREATED", sequence=1,
            payload_json=json.dumps({"template_id": "default", "user_prompt": "hi"}),
            metadata_json="{}",
        ))
        conn.execute(insert(EventModel.__table__).values(
            id="evt_01AAAAAAAAAAAAAAAAAAAAAAAB", session_id="ses_old", tenant_id="default",
            type="SESSION_CREATED", sequence=2,
            payload_json=json.dumps({"template_id": "agent:default"}),  # 已规范 → 幂等不动
            metadata_json="{}",
        ))
        conn.execute(insert(SnapshotModel.__table__).values(
            id="snp_1", session_id="ses_old",
            last_event_id="evt_01AAAAAAAAAAAAAAAAAAAAAAAA", last_event_sequence=1,
            state_blob_json=json.dumps(
                {"sessions": {"ses_old": {"id": "ses_old", "template_id": "default"}}}),
        ))
    engine.dispose()
    return gzip.compress(db.read_bytes())


async def test_import_canonicalizes_payload_template_ids(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'live.db').as_posix()}")
    new_sid = await import_session_db(_make_dump(tmp_path), factory)

    from sqlalchemy import select
    async with factory() as db:
        payloads = [json.loads(p) for (p,) in (await db.execute(
            select(EventModel.payload_json).where(EventModel.session_id == new_sid)
        )).all()]
        blob = (await db.execute(
            select(SnapshotModel.state_blob_json).where(SnapshotModel.session_id == new_sid)
        )).scalar_one()

    tids = sorted(p["template_id"] for p in payloads)
    assert tids == ["agent:default", "agent:default"]  # 裸的被规范化，已规范的幂等
    state = json.loads(blob)
    assert all(s["template_id"] == "agent:default" for s in state["sessions"].values())
