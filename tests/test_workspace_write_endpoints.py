"""host 侧 workspace **写**端点：上传 / 打包下载 / 删文件 / 删目录。

直接调用路由函数（同 test_workspace_endpoints），用内存 _sessions 注入登记根。

写操作的错判后果和读不一样：读越权最多是看到不该看的，写越权是**改掉**不该改的，而且
成功了不报错。所以这里逐条钉死每道闸——越权路径、根自身、文件名上跳、活跃会话占用、
大小上限——每一条都是"漏掉了也不会有任何现象"的那种。
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile

from netlivecowork.api import workspace as ws_api
from netlivecowork.api.models import session as sm


class _Entry:
    def __init__(self, workspace: str, status: str = "COMPLETED") -> None:
        self.workspace = workspace
        self.status = status


@pytest.fixture
def register(tmp_path):
    root = tmp_path / "ws"
    (root / "sub").mkdir(parents=True)
    (root / "keep.txt").write_text("hi", encoding="utf-8")
    (root / "sub" / "a.md").write_text("# A", encoding="utf-8")
    saved = dict(sm._sessions)
    sm._sessions.clear()
    sm._sessions["s1"] = _Entry(str(root))
    yield root
    sm._sessions.clear()
    sm._sessions.update(saved)


def _upload(name: str, data: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


# ── 上传 ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_lands_in_target(register):
    out = await ws_api.upload_files(path=str(register / "sub"), files=[_upload("n.txt", b"abc")])
    assert out.path == str(register / "sub")
    assert [e.name for e in out.uploaded] == ["n.txt"]
    assert (register / "sub" / "n.txt").read_bytes() == b"abc"
    assert out.uploaded[0].size == 3


@pytest.mark.asyncio
async def test_upload_name_cannot_climb_out(register):
    """文件名是客户端给的：不收敛的话 `../` 就能写到工作区之外，而且写成功了不报错。"""
    await ws_api.upload_files(path=str(register / "sub"), files=[_upload("../../evil.txt", b"x")])
    assert not (register.parent / "evil.txt").exists()
    assert (register / "sub" / "evil.txt").read_bytes() == b"x"


@pytest.mark.asyncio
async def test_upload_outside_registered_root_is_403(register, tmp_path):
    with pytest.raises(HTTPException) as ei:
        await ws_api.upload_files(path=str(tmp_path / "elsewhere"), files=[_upload("a.txt", b"x")])
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_upload_over_size_limit_leaves_no_half_file(register, monkeypatch):
    """超限要在**写入过程中**中止并清掉半截文件——留半截比拒绝更糟：用户看到文件在，内容是残的。"""
    from netlivecowork import config

    real = config.get_settings()
    monkeypatch.setattr(
        config, "get_settings", lambda: real.__class__(**{**real.__dict__, "workspace_max_upload_bytes": 4})
    )
    with pytest.raises(HTTPException) as ei:
        await ws_api.upload_files(path=str(register), files=[_upload("big.bin", b"0123456789")])
    assert ei.value.status_code == 413
    assert not (register / "big.bin").exists()


@pytest.mark.asyncio
async def test_upload_refuses_to_clobber_a_directory(register):
    with pytest.raises(HTTPException) as ei:
        await ws_api.upload_files(path=str(register), files=[_upload("sub", b"x")])
    assert ei.value.status_code == 409


# ── 打包下载 ─────────────────────────────────────────────────────────────────


def test_download_zips_the_tree(register):
    resp = ws_api.download_folder(path=str(register))
    names = set(zipfile.ZipFile(resp.path).namelist())
    assert names == {"keep.txt", "sub/a.md"}          # 相对路径，不带绝对前缀


def test_download_outside_root_is_403(register, tmp_path):
    with pytest.raises(HTTPException) as ei:
        ws_api.download_folder(path=str(tmp_path))
    assert ei.value.status_code == 403


def test_download_over_limit_is_413(register, monkeypatch):
    from netlivecowork import config

    real = config.get_settings()
    monkeypatch.setattr(
        config, "get_settings", lambda: real.__class__(**{**real.__dict__, "workspace_max_download_bytes": 1})
    )
    with pytest.raises(HTTPException) as ei:
        ws_api.download_folder(path=str(register))
    assert ei.value.status_code == 413


# ── 删除 ─────────────────────────────────────────────────────────────────────


def test_delete_file(register):
    out = ws_api.delete_file(path=str(register / "keep.txt"))
    assert out["deleted"] is True
    assert not (register / "keep.txt").exists()


def test_delete_file_refuses_a_directory(register):
    """目录走 /dir：那条路的判据更严（要看活跃会话），从 /file 溜进去就绕过了。"""
    with pytest.raises(HTTPException) as ei:
        ws_api.delete_file(path=str(register / "sub"))
    assert ei.value.status_code == 400
    assert (register / "sub").is_dir()


def test_delete_outside_root_is_403(register, tmp_path):
    victim = tmp_path / "outside.txt"
    victim.write_text("x", encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        ws_api.delete_file(path=str(victim))
    assert ei.value.status_code == 403
    assert victim.exists()


def test_delete_dir_recursive(register):
    out = ws_api.delete_dir(path=str(register / "sub"))
    assert out["deleted"] is True
    assert not (register / "sub").exists()


def test_delete_dir_refuses_the_root_itself(register):
    with pytest.raises(HTTPException) as ei:
        ws_api.delete_dir(path=str(register))
    assert ei.value.status_code == 400
    assert register.is_dir()


def test_delete_dir_blocked_while_a_session_is_running(register):
    """把正在干活的 agent 的工作目录抽掉 → 它下一步读写莫名其妙地失败，现场已经没了。

    会话的工作区是待删目录的**子目录**：目录本身就是某会话的根时，更靠前的"不删根"
    那道闸就拦下了，走不到这里，测不出占用判据到底有没有生效。
    """
    (register / "sub" / "inner").mkdir()
    sm._sessions["s2"] = _Entry(str(register / "sub" / "inner"), status="RUNNING")
    with pytest.raises(HTTPException) as ei:
        ws_api.delete_dir(path=str(register / "sub"))
    assert ei.value.status_code == 409
    assert (register / "sub").is_dir()


def test_delete_dir_allowed_when_the_session_has_finished(register):
    """已结束的会话不拦：最坏是回看时文件没了，不是当场把谁干挂。"""
    (register / "sub" / "inner").mkdir()
    sm._sessions["s2"] = _Entry(str(register / "sub" / "inner"), status="COMPLETED")
    assert ws_api.delete_dir(path=str(register / "sub"))["deleted"] is True


def test_delete_dir_missing_is_404(register):
    with pytest.raises(HTTPException) as ei:
        ws_api.delete_dir(path=str(register / "nope"))
    assert ei.value.status_code == 404
