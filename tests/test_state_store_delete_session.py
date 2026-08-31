"""delete_session must remove FK-children (tasks + snapshots) before the session row.

Regression: snapshots.session_id FK-references sessions.id with no ON DELETE CASCADE.
With PRAGMA foreign_keys=ON, deleting a session that still has a snapshot row failed
(sqlite3.IntegrityError: FOREIGN KEY constraint failed). delete_session only cleaned up
tasks, not snapshots.
"""

from __future__ import annotations

from sqlalchemy import func, select

from netlivecowork.persistence.postgres import init_db
from netlivecowork.persistence.postgres.models import SessionModel, SnapshotModel, TaskModel
from netlivecowork.persistence.postgres.state_store import PostgresStateStore


async def test_delete_session_removes_snapshot_children(tmp_path) -> None:
    factory = await init_db(f"sqlite:///{(tmp_path / 'del.db').as_posix()}")
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go"))
            db.add(TaskModel(id="t1", session_id="s1"))
            db.add(SnapshotModel(
                id="snp1", session_id="s1", last_event_id="e1",
                last_event_sequence=1, state_blob_json="{}",
            ))

    # Must not raise (previously: FOREIGN KEY constraint failed on the snapshot child).
    await PostgresStateStore(factory).delete_session("s1")

    async with factory() as db:
        assert await db.get(SessionModel, "s1") is None
        snaps = (await db.execute(
            select(func.count()).select_from(SnapshotModel)
            .where(SnapshotModel.session_id == "s1")
        )).scalar_one()
        tasks = (await db.execute(
            select(func.count()).select_from(TaskModel)
            .where(TaskModel.session_id == "s1")
        )).scalar_one()
    assert snaps == 0
    assert tasks == 0
