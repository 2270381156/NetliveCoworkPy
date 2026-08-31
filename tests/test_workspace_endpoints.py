"""host 侧只读 workspace 端点。直接调用路由函数（参照 test_hitl_rest_cold_resume），
用内存 _sessions 注入登记根，覆盖列目录形状 / 文本 / 原始字节 / 越权 403 / 404 / 非 UTF-8 400。"""
from __future__ import annotations

import os

import pytest
from fastapi import HTTPException

from netlivecowork.api import workspace as ws_api
from netlivecowork.api.models import session as sm


class _Entry:
    def __init__(self, workspace: str) -> None:
        self.workspace = workspace


@pytest.fixture
def ws_root(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "hello.txt").write_text("hi", encoding="utf-8")
    (tmp_path / "sub" / "a.md").write_text("# A", encoding="utf-8")
    return tmp_path


@pytest.fixture
def register(ws_root):
    saved = dict(sm._sessions)
    sm._sessions.clear()
    sm._sessions["s1"] = _Entry(str(ws_root))
    yield ws_root
    sm._sessions.clear()
    sm._sessions.update(saved)


def test_list_files_shape(register):
    listing = ws_api.list_files(path=str(register))
    names = {e.name: e for e in listing.entries}
    assert names["sub"].is_dir is True
    assert names["hello.txt"].is_dir is False
    assert names["hello.txt"].size == 2
    assert listing.entries[0].is_dir is True          # 目录在前
    assert os.path.isabs(listing.entries[0].path)     # entry.path 绝对


def test_read_file_text(register):
    out = ws_api.read_file(path=str(register / "hello.txt"))
    assert out["content"] == "hi"
    assert os.path.isabs(out["path"])


def test_read_file_raw(register):
    resp = ws_api.read_file_raw(path=str(register / "hello.txt"))
    assert os.path.normpath(resp.path) == os.path.normpath(str(register / "hello.txt"))


def test_outside_root_403(register, tmp_path_factory):
    other = tmp_path_factory.mktemp("other")
    (other / "secret.txt").write_text("x", encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(other / "secret.txt"))
    assert ei.value.status_code == 403


def test_missing_404(register):
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(register / "nope.txt"))
    assert ei.value.status_code == 404


def test_non_utf8_400(register):
    p = register / "bin.dat"
    p.write_bytes(b"\xff\xfe\x00\x01")
    with pytest.raises(HTTPException) as ei:
        ws_api.read_file(path=str(p))
    assert ei.value.status_code == 400
