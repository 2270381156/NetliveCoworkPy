"""rewind API 端点测试：list / restore-to-turn（隔离 FastAPI app + 真实 manager over 临时工作区）。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from netlivecowork.api import deps
from netlivecowork.api.rewind import router
from netlivecowork.rewind.manager import RewindManager


def _client(mgr) -> TestClient:
    deps.set_rewind_manager(mgr)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_list_and_restore_to_turn(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "a.txt").write_text("v1", encoding="utf-8")
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: str(ws), keep=30, max_file_mb=100)
    asyncio.run(mgr.snapshot_turn("s1", 1, str(ws)))       # 回合 1 前：v1
    client = _client(mgr)

    r = client.get("/rewind/s1/checkpoints")
    assert r.status_code == 200
    cks = r.json()["checkpoints"]
    assert len(cks) == 1 and cks[0]["turn"] == 1

    (ws / "a.txt").write_text("v2", encoding="utf-8")
    r2 = client.post("/rewind/s1/restore-to-turn", json={"turn": 1})
    assert r2.status_code == 200
    body = r2.json()
    safety = body["safety_checkpoint_id"]
    assert body["restored"] >= 1 and safety is not None  # 回滚前留安全档，供撤销
    assert (ws / "a.txt").read_text(encoding="utf-8") == "v1"

    # 撤销回滚：回到安全档 → a.txt 恢复成回滚前的 v2
    r3 = client.post("/rewind/s1/undo", json={"safety_checkpoint_id": safety, "turn": 1})
    assert r3.status_code == 200
    assert (ws / "a.txt").read_text(encoding="utf-8") == "v2"

    # 安全档不存在 → 404（撤销窗口失效）
    r4 = client.post("/rewind/s1/undo", json={"safety_checkpoint_id": "ckpt-9999", "turn": 1})
    assert r4.status_code == 404


def test_restore_unknown_turn_404(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; ws.mkdir()
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: str(ws), keep=30, max_file_mb=100)
    client = _client(mgr)
    r = client.post("/rewind/s1/restore-to-turn", json={"turn": 99})
    assert r.status_code == 404


def test_disabled_returns_503(tmp_path: Path) -> None:
    deps.set_rewind_manager(None)
    app = FastAPI(); app.include_router(router)
    client = TestClient(app)
    assert client.get("/rewind/s1/checkpoints").status_code == 503
