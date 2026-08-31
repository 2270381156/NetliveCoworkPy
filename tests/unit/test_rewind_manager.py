"""RewindManager 单元测试：回合边界拍快照 + 按回合回滚。asyncio.run，不依赖 pytest-asyncio。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from netlivecowork.rewind.manager import RewindManager


def test_snapshot_turn_and_restore_turn(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "a.txt").write_text("v1", encoding="utf-8")
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: str(ws), keep=30, max_file_mb=100)

    async def scenario():
        # 回合 1 开始前：初始状态
        await mgr.snapshot_turn("s1", 1, str(ws))
        (ws / "a.txt").write_text("v2", encoding="utf-8")
        (ws / "b.txt").write_text("added", encoding="utf-8")
        # 回合 2 开始前
        await mgr.snapshot_turn("s1", 2, str(ws))

        turns = [c.turn for c in mgr.list("s1")]
        assert turns == [1, 2]

        # 回滚到回合 1（撤销回合 1 之后的一切）；回滚前先拍一张"安全档"，供「撤销回滚」恢复。
        res = mgr.restore_turn("s1", 1)
        assert (ws / "a.txt").read_text(encoding="utf-8") == "v1"
        assert not (ws / "b.txt").exists()
        assert res.safety_checkpoint_id is not None
        # 撤销回滚：回到安全档 = 回滚之前的状态（b.txt 回来、a.txt 复原成 v2）。
        mgr.restore("s1", res.safety_checkpoint_id)
        assert (ws / "b.txt").exists()
        assert (ws / "a.txt").read_text(encoding="utf-8") == "v2"

    asyncio.run(scenario())


def test_snapshot_turn_idempotent(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "a.txt").write_text("x", encoding="utf-8")
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: str(ws), keep=30, max_file_mb=100)

    async def scenario():
        await mgr.snapshot_turn("s1", 1, str(ws))
        await mgr.snapshot_turn("s1", 1, str(ws))          # 同 turn 重复 → 不拍第二张
        assert len(mgr.list("s1")) == 1

    asyncio.run(scenario())


def test_no_workspace_is_noop(tmp_path: Path) -> None:
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: None, keep=30, max_file_mb=100)

    async def scenario():
        await mgr.snapshot_turn("s1", 1, None)
        assert mgr.list("s1") == []

    asyncio.run(scenario())


def test_session_finished_drops_memory_keeps_disk(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "a.txt").write_text("x", encoding="utf-8")
    mgr = RewindManager(tmp_path / "ck", workspace_lookup=lambda sid: str(ws), keep=30, max_file_mb=100)

    async def scenario():
        await mgr.snapshot_turn("s1", 1, str(ws))
        await mgr.on_event(SimpleNamespace(type="SessionFinished", session_id="s1"))
        assert len(mgr.list("s1")) == 1                    # 内存释放后仍能从磁盘读回

    asyncio.run(scenario())
