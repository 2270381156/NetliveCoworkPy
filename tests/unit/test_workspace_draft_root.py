"""draft-root 端点测试：草稿工作区登记/清除（隔离 FastAPI app，不动真实 session 注册表）。

覆盖：登记后面板可浏览所选目录、清除后回到 403、非法路径 400、
登记 A 不放行未登记的 B（安全不回退）、重复登记替换。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from netlivecowork.api import workspace
from netlivecowork.api.models import session as _sm


def _client() -> TestClient:
    _sm._sessions.clear()          # 隔离：不带任何已存在会话根
    workspace._draft_root = None   # 隔离：清掉上一个用例的草稿根
    app = FastAPI()
    app.include_router(workspace.router)
    return TestClient(app)


def test_no_root_then_register_then_browse(tmp_path: Path) -> None:
    ws = tmp_path / "proj"; ws.mkdir()
    (ws / "a.txt").write_text("hi", encoding="utf-8")
    sub = ws / "src"; sub.mkdir()
    client = _client()

    # 无任何登记根 → 403
    assert client.get("/workspace/files", params={"path": str(ws)}).status_code == 403

    # 登记草稿根 → 可浏览，条目排序（目录在前）
    r = client.post("/workspace/draft-root", json={"path": str(ws)})
    assert r.status_code == 200 and Path(r.json()["path"]) == ws.resolve()
    r2 = client.get("/workspace/files", params={"path": str(ws)})
    assert r2.status_code == 200
    body = r2.json()
    assert body["root"] == str(ws.resolve())
    names = [(e["name"], e["is_dir"]) for e in body["entries"]]
    assert ("src", True) in names and ("a.txt", False) in names

    # 子目录导航也放行，parent 指回草稿根
    r3 = client.get("/workspace/files", params={"path": str(sub)})
    assert r3.status_code == 200 and r3.json()["parent"] == str(ws.resolve())

    # 文件预览读接口同样受草稿根放行
    r4 = client.get("/workspace/file", params={"path": str(ws / "a.txt")})
    assert r4.status_code == 200 and r4.json()["content"] == "hi"


def test_clear_restores_403(tmp_path: Path) -> None:
    ws = tmp_path / "proj"; ws.mkdir()
    client = _client()
    assert client.post("/workspace/draft-root", json={"path": str(ws)}).status_code == 200

    assert client.delete("/workspace/draft-root").status_code == 200
    assert client.get("/workspace/files", params={"path": str(ws)}).status_code == 403
    # 幂等：重复清除不报错
    assert client.delete("/workspace/draft-root").status_code == 200


def test_invalid_paths_rejected(tmp_path: Path) -> None:
    client = _client()
    assert client.post("/workspace/draft-root", json={"path": "relative/dir"}).status_code == 400
    assert client.post("/workspace/draft-root", json={"path": str(tmp_path / "nope")}).status_code == 400
    f = tmp_path / "f.txt"; f.write_text("x", encoding="utf-8")
    assert client.post("/workspace/draft-root", json={"path": str(f)}).status_code == 400


def test_registered_a_does_not_authorize_b(tmp_path: Path) -> None:
    a = tmp_path / "a"; a.mkdir()
    b = tmp_path / "b"; b.mkdir()
    (b / "secret.txt").write_text("s", encoding="utf-8")
    client = _client()
    assert client.post("/workspace/draft-root", json={"path": str(a)}).status_code == 200

    # 同级未登记目录 B → 403（安全模型不因草稿根放宽）
    assert client.get("/workspace/files", params={"path": str(b)}).status_code == 403
    assert client.get("/workspace/file", params={"path": str(b / "secret.txt")}).status_code == 403


def test_reregister_replaces(tmp_path: Path) -> None:
    a = tmp_path / "a"; a.mkdir()
    b = tmp_path / "b"; b.mkdir()
    client = _client()
    client.post("/workspace/draft-root", json={"path": str(a)})
    client.post("/workspace/draft-root", json={"path": str(b)})

    assert client.get("/workspace/files", params={"path": str(b)}).status_code == 200
    assert client.get("/workspace/files", params={"path": str(a)}).status_code == 403
