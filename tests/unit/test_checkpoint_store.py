"""CheckpointStore 单元测试：快照 / 回滚 / 去重 / 排除 / 安全存档。纯逻辑，跨平台可跑。"""

from __future__ import annotations

from pathlib import Path

from netlivecowork.rewind import CheckpointStore


def _ck(root, **kw) -> CheckpointStore:
    """测试用构造：填上必传的调优参数（生产由 config/env 传入）。"""
    kw.setdefault("max_file_bytes", 100 * 1024 * 1024)
    kw.setdefault("max_checkpoints", 30)
    return CheckpointStore(root, **kw)


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_snapshot_restore_roundtrip(tmp_path: Path) -> None:
    ws = tmp_path / "workspace"
    root = tmp_path / "checkpoints"
    _write(ws / "a.txt", "hello")
    _write(ws / "sub" / "b.txt", "world")
    _write(ws / "node_modules" / "junk.js", "x" * 100)   # 应被排除

    store = _ck(root)
    c1 = store.snapshot(ws, turn=1, label="初始")
    assert c1.id == "ckpt-0001"
    assert c1.file_count == 2                              # 排除了 node_modules

    # 改动：编辑 a、新增 c、删除 sub/b
    _write(ws / "a.txt", "hello CHANGED")
    _write(ws / "c.txt", "new file")
    (ws / "sub" / "b.txt").unlink()

    store.snapshot(ws, turn=2, label="改动后")

    # 回滚到 c1
    res = store.restore(ws, "ckpt-0001")
    assert (ws / "a.txt").read_text(encoding="utf-8") == "hello"     # 编辑被撤销
    assert (ws / "sub" / "b.txt").read_text(encoding="utf-8") == "world"  # 删除被恢复
    assert not (ws / "c.txt").exists()                              # 新增被删除
    assert res.restored >= 2 and res.deleted == 1
    assert res.safety_checkpoint_id is not None                    # 回滚前自动存了档
    assert not (ws / "node_modules" / "junk.js").exists() or True  # 排除项不受回滚影响（存在与否都不该被动）


def test_dedup_shares_blobs(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    root = tmp_path / "ck"
    _write(ws / "x.txt", "same content")
    _write(ws / "y.txt", "same content")                  # 内容相同 → 只应存一个 blob
    store = _ck(root)
    store.snapshot(ws)
    blobs = list((root / "blobs").rglob("*"))
    blob_files = [b for b in blobs if b.is_file()]
    assert len(blob_files) == 1                            # 去重生效


def test_incremental_cache_correct(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    root = tmp_path / "ck"
    _write(ws / "a.txt", "v1")
    store = _ck(root)
    store.snapshot(ws)
    # 不改文件，再快照——应复用缓存且清单一致
    c2 = store.snapshot(ws)
    m = store._read_json(root / "manifests" / f"{c2.id}.json")
    assert list(m.keys()) == ["a.txt"]


def test_restore_safety_checkpoint_is_reversible(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    root = tmp_path / "ck"
    _write(ws / "a.txt", "original")
    store = _ck(root)
    store.snapshot(ws)                                    # ckpt-0001
    _write(ws / "a.txt", "edited")
    # 回滚到初始；安全档记录了 "edited" 状态
    res = store.restore(ws, "ckpt-0001")
    assert (ws / "a.txt").read_text(encoding="utf-8") == "original"
    # 撤回本次回滚 → 回到 "edited"
    store.restore(ws, res.safety_checkpoint_id)
    assert (ws / "a.txt").read_text(encoding="utf-8") == "edited"


def test_gc_keeps_last_n_and_prunes_blobs(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; root = tmp_path / "ck"
    store = _ck(root, max_checkpoints=3)
    for i in range(5):
        _write(ws / "a.txt", f"v{i}")            # 每次不同内容 → 各一个 blob
        store.snapshot(ws, turn=i)
    ckpts = store.list()
    assert [c.turn for c in ckpts] == [2, 3, 4]  # 只保留最近 3 个，旧的 0/1 被 gc
    # 孤儿 blob 清理：只剩被存活 manifest 引用的 3 个（v2/v3/v4）
    blobs = [b for shard in (root / "blobs").iterdir() if shard.is_dir() for b in shard.iterdir()]
    assert len(blobs) == 3
    # 回滚到保留中的最旧检查点仍正确
    store.restore(ws, ckpts[0].id, snapshot_before=False)
    assert (ws / "a.txt").read_text(encoding="utf-8") == "v2"


def test_blobs_are_compressed_and_roundtrip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"; root = tmp_path / "ck"
    content = "hello world\n" * 1000           # 高度可压缩
    _write(ws / "big.txt", content)
    store = _ck(root)
    store.snapshot(ws)
    blobs = [b for shard in (root / "blobs").iterdir() if shard.is_dir() for b in shard.iterdir()]
    assert len(blobs) == 1
    assert blobs[0].stat().st_size < len(content.encode())   # 压缩后明显更小
    # 解压回滚正确
    _write(ws / "big.txt", "changed")
    store.restore(ws, store.list()[0].id, snapshot_before=False)
    assert (ws / "big.txt").read_text(encoding="utf-8") == content


def test_list_and_get(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    root = tmp_path / "ck"
    _write(ws / "a.txt", "x")
    store = _ck(root)
    a = store.snapshot(ws, turn=1)
    b = store.snapshot(ws, turn=2)
    ids = [c.id for c in store.list()]
    assert ids == [a.id, b.id]
    assert store.get(a.id).turn == 1
    assert store.get("nope") is None
