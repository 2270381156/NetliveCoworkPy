"""CheckpointStore —— 工作区文件的内容寻址快照 / 回滚引擎（纯逻辑，零外部依赖）。

设计（《全自动模式安全设计》§6）：只管**工作区文件**，不碰对话/事件溯源。

存储布局（在会话数据目录下、工作区之外）::

    <root>/
      blobs/<sha[:2]>/<sha>        去重的文件内容（相同内容只存一份）
      manifests/<checkpoint>.json  { 相对路径(posix): sha256 }
      index.json                   { next_seq, checkpoints: [{id, turn, label, ...}] }
      stat_cache.json              { 相对路径: [mtime, size, sha] }  用于增量：没变的文件跳过重算

快照 = 遍历工作区 → 每文件算 sha（用 stat_cache 跳过未变的）→ 新内容才落 blob → 写清单。
回滚 = 读目标清单 → 按清单把 blob 写回、删掉清单外的文件；默认先给当前状态存一张"回滚前"检查点，
所以回滚本身也可撤。

线程/并发：假设快照/回滚都在会话回合边界的静止点、由后端串行调用；不做跨进程加锁。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import zlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# 默认排除的目录名（不快照、回滚时也不碰）——大而易再生 / 版本控制内部。
DEFAULT_EXCLUDE_DIRS = frozenset({
    ".git", ".hg", ".svn",
    "node_modules", ".venv", "venv", "env",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".idea", ".vscode", ".DS_Store",
})
DEFAULT_EXCLUDE_FILES = frozenset({".DS_Store"})
# max_file_bytes / max_checkpoints 不设组件默认——由调用方（生产走 config/env，测试显式传）
# 决定，避免默认值散落在多处。见 config.py 的 NLC_REWIND_*。


@dataclass(frozen=True)
class Checkpoint:
    """一个检查点的元数据（不含文件内容；内容在 blobs + manifest）。"""
    id: str
    turn: int | None
    label: str
    created_at: str          # ISO-8601 UTC
    file_count: int
    total_bytes: int
    skipped: int             # 因超限/无法读取被跳过的文件数


@dataclass
class RestoreResult:
    restored: int            # 写回（新建或覆盖）的文件数
    deleted: int             # 删除（检查点之后新建的）文件数
    unchanged: int           # 内容已一致、未动的文件数
    safety_checkpoint_id: str | None  # 回滚前自动存的"当前状态"检查点（可撤回本次回滚）


class CheckpointStore:
    """某个会话工作区的检查点仓库。root 建议 ``<data>/checkpoints/<session>/``。"""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        max_file_bytes: int,
        max_checkpoints: int,
        exclude_dirs: frozenset[str] = DEFAULT_EXCLUDE_DIRS,
        exclude_files: frozenset[str] = DEFAULT_EXCLUDE_FILES,
    ) -> None:
        self.root = Path(root)
        self._blobs = self.root / "blobs"
        self._manifests = self.root / "manifests"
        self._index_path = self.root / "index.json"
        self._stat_cache_path = self.root / "stat_cache.json"
        self._exclude_dirs = exclude_dirs
        self._exclude_files = exclude_files
        self._max_file_bytes = max_file_bytes
        self._max_checkpoints = max(1, max_checkpoints)
        self._blobs.mkdir(parents=True, exist_ok=True)
        self._manifests.mkdir(parents=True, exist_ok=True)

    # ── 快照 ────────────────────────────────────────────────────────────────
    def snapshot(self, workspace: str | os.PathLike[str], *, turn: int | None = None,
                 label: str = "") -> Checkpoint:
        """给工作区当前状态拍一张检查点。返回其元数据。"""
        ws = Path(workspace)
        old_cache = self._load_stat_cache()
        new_cache: dict[str, list] = {}
        manifest: dict[str, str] = {}
        total_bytes = 0
        skipped = 0

        for rel, abspath, size, mtime in self._iter_files(ws):
            cached = old_cache.get(rel)
            if cached and cached[0] == mtime and cached[1] == size:
                sha = cached[2]                       # 未变：复用缓存的 sha，跳过重算
            else:
                sha = self._hash_and_store(abspath)
                if sha is None:                       # 读不动（权限等）→ 跳过
                    skipped += 1
                    continue
            manifest[rel] = sha
            new_cache[rel] = [mtime, size, sha]
            total_bytes += size

        skipped += self._skipped_oversize  # _iter_files 里累计的超限跳过
        index = self._load_index()
        seq = index["next_seq"]
        index["next_seq"] = seq + 1
        cid = f"ckpt-{seq:04d}"
        self._write_json(self._manifests / f"{cid}.json", manifest)

        ckpt = Checkpoint(
            id=cid, turn=turn, label=label,
            created_at=datetime.now(timezone.utc).isoformat(),
            file_count=len(manifest), total_bytes=total_bytes, skipped=skipped,
        )
        index["checkpoints"].append(asdict(ckpt))
        self._write_json(self._index_path, index)
        self._write_json(self._stat_cache_path, new_cache)
        self._gc()                                # 超出保留上限则丢最旧 + 清理孤儿 blob
        return ckpt

    # ── 列表 ────────────────────────────────────────────────────────────────
    def list(self) -> list[Checkpoint]:
        """按创建顺序返回所有检查点元数据。"""
        return [Checkpoint(**c) for c in self._load_index()["checkpoints"]]

    def get(self, checkpoint_id: str) -> Checkpoint | None:
        for c in self._load_index()["checkpoints"]:
            if c["id"] == checkpoint_id:
                return Checkpoint(**c)
        return None

    # ── 回滚 ────────────────────────────────────────────────────────────────
    def restore(self, workspace: str | os.PathLike[str], checkpoint_id: str, *,
                snapshot_before: bool = True) -> RestoreResult:
        """把工作区文件回滚到某检查点。

        snapshot_before=True 时先给"当前状态"存一张检查点，使本次回滚可撤回。
        """
        ws = Path(workspace)
        manifest_path = self._manifests / f"{checkpoint_id}.json"
        if not manifest_path.exists():
            raise KeyError(f"未知检查点: {checkpoint_id}")
        target: dict[str, str] = self._read_json(manifest_path)

        safety_id: str | None = None
        if snapshot_before:
            safety_id = self.snapshot(ws, label="回滚前自动存档").id

        # 当前工作区里（快照范围内）的相对路径集合
        current = {rel for rel, *_ in self._iter_files(ws)}

        restored = unchanged = deleted = 0
        # 1) 按目标清单写回
        for rel, sha in target.items():
            abspath = ws / rel
            if rel in current and self._file_sha(abspath) == sha:
                unchanged += 1
                continue
            self._write_blob_to(abspath, sha)
            restored += 1
        # 2) 删掉目标清单里没有、但现在存在的（= 检查点之后新建的）
        for rel in current - target.keys():
            try:
                (ws / rel).unlink()
                deleted += 1
            except OSError:
                pass
        self._prune_empty_dirs(ws)

        # 回滚后工作区 == 目标；清空 stat_cache 让下次快照按真实状态重算（正确优先）
        self._write_json(self._stat_cache_path, {})
        return RestoreResult(restored=restored, deleted=deleted, unchanged=unchanged,
                             safety_checkpoint_id=safety_id)

    # ── 内部 ────────────────────────────────────────────────────────────────
    def _iter_files(self, ws: Path):
        """遍历工作区，产出 (相对路径posix, 绝对Path, size, mtime_ns)。剪掉排除目录/文件/超大文件/符号链接。"""
        self._skipped_oversize = 0
        if not ws.exists():
            return
        for dirpath, dirnames, filenames in os.walk(ws):
            dirnames[:] = [d for d in dirnames if d not in self._exclude_dirs]
            for name in filenames:
                if name in self._exclude_files:
                    continue
                abspath = Path(dirpath) / name
                try:
                    if abspath.is_symlink():
                        continue                      # 不快照符号链接
                    st = abspath.stat()
                except OSError:
                    continue
                if st.st_size > self._max_file_bytes:
                    self._skipped_oversize += 1
                    continue
                rel = abspath.relative_to(ws).as_posix()
                yield rel, abspath, st.st_size, st.st_mtime_ns

    def _blob_path(self, sha: str) -> Path:
        return self._blobs / sha[:2] / sha

    def _hash_and_store(self, abspath: Path) -> str | None:
        """算 sha256（对原始内容）并（若首见）落【zlib 压缩后】的 blob。返回 sha；读不动返回 None。"""
        try:
            data = abspath.read_bytes()               # 单文件 ≤ 上限，整读入内存无妨
        except OSError:
            return None
        sha = hashlib.sha256(data).hexdigest()        # sha 对【原始内容】算 → 去重仍按内容
        dst = self._blob_path(sha)
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_suffix(".tmp")
            try:
                tmp.write_bytes(zlib.compress(data, 6))  # 存压缩后的字节
                os.replace(tmp, dst)                     # 原子落盘，避免半截 blob
            except OSError:
                tmp.unlink(missing_ok=True)
                return None
        return sha

    def _read_blob(self, sha: str) -> bytes:
        """读回某 blob 的原始内容（解压；对旧的未压缩 blob 兼容回退）。"""
        raw = self._blob_path(sha).read_bytes()
        try:
            return zlib.decompress(raw)
        except zlib.error:
            return raw                                 # 兼容压缩改造前存的未压缩 blob

    def _file_sha(self, abspath: Path) -> str | None:
        h = hashlib.sha256()
        try:
            with open(abspath, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
        except OSError:
            return None
        return h.hexdigest()

    def _write_blob_to(self, abspath: Path, sha: str) -> None:
        """把某 blob 的原始内容（解压后）写到工作区路径（新建父目录，原子替换）。"""
        abspath.parent.mkdir(parents=True, exist_ok=True)
        tmp = abspath.with_suffix(abspath.suffix + ".rwtmp")
        tmp.write_bytes(self._read_blob(sha))
        os.replace(tmp, abspath)

    def _gc(self) -> None:
        """保留最近 N 个检查点：丢弃更旧的（删其 manifest + index 条目），再清理不再被
        任何存活 manifest 引用的 blob。检查点按创建顺序，越靠前越旧。"""
        index = self._load_index()
        ckpts = index["checkpoints"]
        if len(ckpts) <= self._max_checkpoints:
            return
        drop = ckpts[: len(ckpts) - self._max_checkpoints]
        keep = ckpts[len(ckpts) - self._max_checkpoints:]
        for c in drop:
            (self._manifests / f"{c['id']}.json").unlink(missing_ok=True)
        index["checkpoints"] = keep
        self._write_json(self._index_path, index)
        # 收集存活 manifest 引用的所有 sha，删掉没被引用的 blob
        alive: set[str] = set()
        for c in keep:
            mp = self._manifests / f"{c['id']}.json"
            if mp.exists():
                alive.update(self._read_json(mp).values())
        pruned_blobs = 0
        for shard in self._blobs.iterdir() if self._blobs.exists() else []:
            if not shard.is_dir():
                continue
            for blob in shard.iterdir():
                if blob.name not in alive:
                    blob.unlink(missing_ok=True)
                    pruned_blobs += 1
            if not any(shard.iterdir()):
                shard.rmdir()
        logger.info("rewind gc: 丢弃旧检查点=%d 保留=%d 清理孤儿 blob=%d",
                    len(drop), len(keep), pruned_blobs)

    def _prune_empty_dirs(self, ws: Path) -> None:
        """删掉回滚后残留的空目录（不碰排除目录、不删工作区根）。"""
        for dirpath, dirnames, filenames in os.walk(ws, topdown=False):
            p = Path(dirpath)
            if p == ws or p.name in self._exclude_dirs:
                continue
            try:
                if not any(p.iterdir()):
                    p.rmdir()
            except OSError:
                pass

    def _load_index(self) -> dict:
        if self._index_path.exists():
            return self._read_json(self._index_path)
        return {"next_seq": 1, "checkpoints": []}

    def _load_stat_cache(self) -> dict[str, list]:
        if self._stat_cache_path.exists():
            try:
                return self._read_json(self._stat_cache_path)
            except (OSError, ValueError):
                return {}
        return {}

    @staticmethod
    def _read_json(path: Path) -> dict:
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _write_json(path: Path, data) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
