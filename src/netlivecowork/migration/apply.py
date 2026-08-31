"""执行导入 —— 把 PLAN 真正落地。

`plan.py` 说搬什么，`gate.py` 说什么时候能搬，**这里是唯一动文件的地方**。

## 三个必须按清单来的动作

    COPY     原样搬。**数据库要先做 WAL 检查点**，否则最近一段写入还在 WAL 里，
             拷过去就丢了——现象是"最近几条会话不见了"，用户会以为导入功能坏了。
    REWRITE  `.env` 里是指向旧目录的绝对路径。照搬的结果是新版跑起来读写的还是旧目录，
             而且**一切正常**——直到用户发现两个应用在互相覆盖。
    MERGE    `mcp.json`。直接覆盖会丢掉新版新增的随包 MCP；直接跳过则丢掉用户自己加的。

## 为什么不做"合并"

`gate.can_import` 已经把"新版还有自己的会话"挡在外面了。走到这里时新版必然是空的，
所以 COPY 就是 COPY，不需要回答"已经用过一阵怎么办"——那是一整套没人测得全的分支。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .plan import PLAN, Action

logger = logging.getLogger(__name__)


@dataclass
class ImportResult:
    copied: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.failed


def _checkpoint_wal(db: Path) -> None:
    """把 WAL 里的写入落进主库再拷。

    不做这一步，最近一段会话就留在 `-wal` 里没进 `.db`，而我们只拷 `.db`。
    结果是导入"成功"了，但最近几条会话不见了——最像"导入功能坏了"的一种坏法。
    """
    try:
        con = sqlite3.connect(str(db))
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            con.commit()
        finally:
            con.close()
    except Exception as e:  # 检查点失败不该中止导入：拷到的可能少几条，总比一条都没有强
        logger.warning("导入：WAL 检查点失败（%s），继续拷贝主库", e)


def _rewrite_env(text: str, legacy_dir: Path, app_data_dir: Path) -> str:
    """把 .env 里指向旧目录的路径改到新目录，并把老前缀改成 NLC_。

    路径比较忽略大小写：Windows 路径大小写不敏感，而用户手改过的 .env 里
    大小写什么样都有。
    """
    old = str(legacy_dir)
    new = str(app_data_dir)
    out_lines = []
    for line in text.splitlines():
        s = line
        # 老版本用过的两个前缀
        s = s.replace("IPMASTER_COWORK_", "NLC_").replace("NETLIVE_COWORK_", "NLC_")
        s = s.replace("IPMC_", "NLC_")
        # 绝对路径：正反斜杠两种写法都换
        for a, b in ((old, new), (old.replace("\\", "/"), new.replace("\\", "/"))):
            if a and a.lower() in s.lower():
                i = s.lower().index(a.lower())
                s = s[:i] + b + s[i + len(a):]
        out_lines.append(s)
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


def _merge_mcp(src: Path, dst: Path) -> None:
    """用户自己加的 MCP 搬过来，新版随包的那些保持不动。"""
    try:
        user = json.loads(src.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("导入：旧 mcp.json 读不动（%s），跳过", e)
        return
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(user, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return
    try:
        cur = json.loads(dst.read_text(encoding="utf-8"))
    except Exception:
        cur = {}

    def merge(a: dict, b: dict) -> dict:
        """b（新版随包）优先；a（用户的）里独有的补进来。"""
        out = dict(a)
        for k, v in b.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = merge(out[k], v)
            else:
                out[k] = v
        return out

    dst.write_text(json.dumps(merge(user, cur), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst)


def import_legacy(legacy_dir: Path, app_data_dir: Path) -> ImportResult:
    """按 PLAN 把旧数据搬过来。**调用方负责先过 gate**。"""
    legacy_dir, app_data_dir = Path(legacy_dir), Path(app_data_dir)
    res = ImportResult()

    for item in PLAN:
        src = legacy_dir / item.path
        dst = app_data_dir / item.path
        if item.action is Action.SKIP:
            res.skipped.append(item.path)
            continue
        if not src.exists():
            res.skipped.append(item.path)
            continue
        try:
            if item.action is Action.COPY:
                if src.suffix == ".db":
                    _checkpoint_wal(src)
                _copy(src, dst)
            elif item.action is Action.REWRITE:
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(
                    _rewrite_env(src.read_text(encoding="utf-8", errors="replace"),
                                 legacy_dir, app_data_dir),
                    encoding="utf-8",
                )
            elif item.action is Action.MERGE:
                _merge_mcp(src, dst)
            res.copied.append(item.path)
        except Exception as e:
            res.failed[item.path] = str(e)
            logger.warning("导入：%s 失败 —— %s", item.path, e)

    _assign_skill_ownership(app_data_dir)
    return res


def _assign_skill_ownership(app_data_dir: Path) -> None:
    """旧的 skill 引用索引里没有归属字段，按固定名单补上。

    不补的话这些 skill 归属为空 = 谁都能用，等于把旧数据的权限放开了。
    """
    p = app_data_dir / "data" / "skill_references.json"
    if not p.exists():
        return
    try:
        from .skill_ownership import assign

        data = json.loads(p.read_text(encoding="utf-8"))
        records = data if isinstance(data, list) else data.get("references") or []
        n = assign(records)
        if n:
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            logger.info("导入：为 %d 条 skill 引用补上了归属", n)
    except Exception as e:
        logger.warning("导入：skill 归属补齐失败 —— %s", e)


def own_session_count(app_data_dir: Path) -> int:
    """新版自己有几条会话 —— gate.can_import 的入参。

    **只读地数，不经过运行期那套** ——导入发生在数据库连上之前，
    这时候 ORM 那一套还没起来，而且也不该为了数个数把它拉起来。
    """
    for name in ("ipmc-dev.db", "netlivecowork.db"):
        db = Path(app_data_dir) / "data" / name
        if not db.exists():
            continue
        try:
            con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            try:
                row = con.execute("SELECT COUNT(*) FROM sessions").fetchone()
                return int(row[0]) if row else 0
            finally:
                con.close()
        except Exception:
            # 表不存在 / 库是坏的 → 当作没有会话；导入的前提本来就是"新版还是空的"
            return 0
    return 0


def legacy_dir_from_env() -> Path | None:
    """上一代的数据目录。由客户端主进程通过 NLC_LEGACY_APPDATA_DIR 下发。

    **不在后端这边推**：目录名来自 branding.legacyAppDataDir，那是客户端的知识；
    后端自己拼一遍就又是一处"两边各推一遍"，迟早对不上。
    """
    raw = (os.getenv("NLC_LEGACY_APPDATA_DIR") or "").strip()
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_dir() else None
