"""存量导入的执行器（migration/apply.py）。

清单和闸门早就有了，执行器一直没写——所以"导入"这件事从来没真正发生过。
这里钉的是清单里每一条"为什么这么搬"的理由：搬错的后果都是静默的。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from netlivecowork.migration import gate
from netlivecowork.migration.apply import (
    _rewrite_env,
    import_legacy,
    own_session_count,
)


def _legacy(tmp: Path) -> Path:
    """造一份看起来像真的旧数据目录。"""
    d = tmp / "IPMaster-Cowork"
    (d / "data").mkdir(parents=True)
    (d / "resources").mkdir(parents=True)

    con = sqlite3.connect(str(d / "data" / "ipmc-dev.db"))
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
    con.executemany("INSERT INTO sessions VALUES (?)", [("ses_a",), ("ses_b",)])
    con.commit(); con.close()

    (d / ".env").write_text(
        f"IPMC_DATA_DIR={d}/data\nIPMASTER_COWORK_LOG_DIR={d}/logs\nFOO=bar\n",
        encoding="utf-8",
    )
    (d / "resources" / "mcp.json").write_text(
        json.dumps({"mcpServers": {"my-own": {"url": "http://me"}}}), encoding="utf-8"
    )
    (d / "data" / "skill_references.json").write_text(json.dumps([]), encoding="utf-8")
    (d / "logs").mkdir()
    (d / "logs" / "old.log").write_text("x", encoding="utf-8")
    (d / "installed-version").write_text("0.5.6", encoding="utf-8")
    return d


# ── 搬什么 ───────────────────────────────────────────────────────────────────


def test_sessions_come_over(tmp_path):
    """导入的全部意义就在这一条：用户的历史会话得在。"""
    new = tmp_path / "NetLIVECowork"
    import_legacy(_legacy(tmp_path), new)
    assert own_session_count(new) == 2


def test_logs_and_venv_are_not_copied(tmp_path):
    new = tmp_path / "NetLIVECowork"
    import_legacy(_legacy(tmp_path), new)
    assert not (new / "logs").exists()


def test_installed_marker_is_not_copied(tmp_path):
    """搬了它，「这是第一次装吗」就判错——而那正是导入引导自己的判据。"""
    new = tmp_path / "NetLIVECowork"
    import_legacy(_legacy(tmp_path), new)
    assert not (new / "installed-version").exists()


# ── .env 必须重写 ────────────────────────────────────────────────────────────


def test_env_paths_are_rewritten_to_the_new_dir(tmp_path):
    """照搬的话新版跑起来读写的还是旧目录，而且一切正常——直到两个应用互相覆盖。"""
    old, new = tmp_path / "IPMaster-Cowork", tmp_path / "NetLIVECowork"
    out = _rewrite_env(f"IPMC_DATA_DIR={old}/data\n", old, new)
    assert str(new) in out and str(old) not in out


def test_env_prefixes_are_renamed(tmp_path):
    out = _rewrite_env("IPMC_LOG_DIR=x\nIPMASTER_COWORK_A=1\nNETLIVE_COWORK_B=2\n",
                       tmp_path / "a", tmp_path / "b")
    assert "NLC_LOG_DIR=x" in out and "NLC_A=1" in out and "NLC_B=2" in out
    assert "IPMC_" not in out and "IPMASTER_COWORK_" not in out


def test_env_keeps_unrelated_lines(tmp_path):
    assert "FOO=bar" in _rewrite_env("FOO=bar\n", tmp_path / "a", tmp_path / "b")


# ── mcp.json 合并 ────────────────────────────────────────────────────────────


def test_user_added_mcp_servers_survive(tmp_path):
    new = tmp_path / "NetLIVECowork"
    (new / "resources").mkdir(parents=True)
    (new / "resources" / "mcp.json").write_text(
        json.dumps({"mcpServers": {"browser-mcp": {"command": "node"}}}), encoding="utf-8"
    )
    import_legacy(_legacy(tmp_path), new)
    got = json.loads((new / "resources" / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]
    assert "my-own" in got, "用户自己加的 MCP 被丢了"
    assert "browser-mcp" in got, "新版随包的 MCP 被旧文件覆盖了"


# ── 闸门 ─────────────────────────────────────────────────────────────────────


def test_import_is_blocked_once_the_new_install_has_sessions(tmp_path):
    """新版已经有会话就不导——这条约束换掉了一整块合并语义。"""
    new = tmp_path / "NetLIVECowork"
    (new / "data").mkdir(parents=True)
    con = sqlite3.connect(str(new / "data" / "ipmc-dev.db"))
    con.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
    con.execute("INSERT INTO sessions VALUES ('mine')")
    con.commit(); con.close()
    assert own_session_count(new) == 1
    assert gate.can_import(new, own_session_count=own_session_count(new)) is False


def test_a_fresh_install_can_import(tmp_path):
    new = tmp_path / "NetLIVECowork"
    new.mkdir()
    assert gate.can_import(new, own_session_count=own_session_count(new)) is True


def test_importing_twice_is_refused(tmp_path):
    new = tmp_path / "NetLIVECowork"
    new.mkdir()
    gate.mark_imported(new)
    assert gate.can_import(new, own_session_count=0) is False


def test_missing_legacy_dir_is_not_an_error(tmp_path):
    res = import_legacy(tmp_path / "nope", tmp_path / "new")
    assert res.ok and not res.copied
