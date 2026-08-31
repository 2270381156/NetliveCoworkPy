"""套件自带的 logo（`branding.logo` + 端点）。

**没有 logo 是正常路径不是故障** —— 界面回落首字母。所以这一组里"404"和"200"同样重要。

⚠ 文件名来自**下发的清单**，会被拼进路径。两道都要挡：解析时削成基名、
提供时 resolve 后仍须在套件目录内。只做其中一道的话，`a/../../b` 这种能混过去 ——
后果是读任意文件。
"""
from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from netlivecowork.api import coworks as api
from netlivecowork.cowork import installed
from netlivecowork.cowork.manifest_parse import LOGO_CANDIDATES, parse


def _suite(root, cid, *, logo_name=None, files=()):
    d = root / cid
    d.mkdir(parents=True, exist_ok=True)
    branding = {"displayName": cid}
    if logo_name is not None:
        branding["logo"] = logo_name
    (d / "cowork.json").write_text(
        json.dumps({"id": cid, "version": 1, "branding": branding}), encoding="utf-8")
    for f in files:
        (d / f).write_bytes(b"<svg/>")
    return d


# ── 解析 ─────────────────────────────────────────────────────────────────────


def test_no_logo_field_means_empty():
    m = parse({"id": "x", "version": 1, "branding": {"displayName": "X"}})
    assert m.logo_file == ""


def test_an_explicit_name_is_kept():
    m = parse({"id": "x", "version": 1, "branding": {"displayName": "X", "logo": "brand.svg"}})
    assert m.logo_file == "brand.svg"


@pytest.mark.parametrize("evil", ["../../etc/passwd", r"..\..\windows\win.ini", "/abs/x.png"])
def test_a_traversing_name_is_reduced_to_its_basename(evil):
    """清单是下发来的。**在解析这一层就削掉** —— 留到端点那层再防，漏一次就是读任意文件。"""
    m = parse({"id": "x", "version": 1, "branding": {"displayName": "X", "logo": evil}})
    assert "/" not in m.logo_file and "\\" not in m.logo_file
    assert m.logo_file not in ("..", ".")


# ── 找文件 ───────────────────────────────────────────────────────────────────


def test_the_conventional_name_is_found_without_a_manifest_field(tmp_path):
    """有约定就不必每个套件都写一行。"""
    _suite(tmp_path, "a", files=["logo.svg"])
    c = installed.get(tmp_path, "a")
    assert api._logo_path(tmp_path, c).name == "logo.svg"


def test_an_explicit_field_wins_over_the_convention(tmp_path):
    _suite(tmp_path, "a", logo_name="brand.png", files=["logo.svg", "brand.png"])
    c = installed.get(tmp_path, "a")
    assert api._logo_path(tmp_path, c).name == "brand.png"


def test_no_file_means_none(tmp_path):
    _suite(tmp_path, "a")
    assert api._logo_path(tmp_path, installed.get(tmp_path, "a")) is None


def test_an_unknown_extension_is_refused(tmp_path):
    """白名单，不是黑名单：让下发的套件决定回什么 Content-Type，
    等于让它在这个源上执行任意脚本。"""
    _suite(tmp_path, "a", logo_name="logo.html", files=["logo.html"])
    assert api._logo_path(tmp_path, installed.get(tmp_path, "a")) is None


def test_a_file_outside_the_suite_dir_is_refused(tmp_path):
    """第二道闸：即便解析那层被绕过，resolve 之后必须仍在套件目录内。"""
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"x")
    _suite(tmp_path, "a")

    class _Fake:
        id = "a"
        logo_file = "../secret.png"       # 手工构造，绕过解析那层的削减

    assert api._logo_path(tmp_path, _Fake()) is None


def test_the_candidates_are_tried_in_order(tmp_path):
    _suite(tmp_path, "a", files=list(LOGO_CANDIDATES))
    got = api._logo_path(tmp_path, installed.get(tmp_path, "a")).name
    assert got == LOGO_CANDIDATES[0], "顺序即优先级"


# ── 端点 ─────────────────────────────────────────────────────────────────────


def test_a_cowork_without_a_logo_gives_404(tmp_path, monkeypatch):
    """**404 是正常路径**：界面据此回落首字母。"""
    _suite(tmp_path, "a")
    monkeypatch.setattr("netlivecowork.paths.coworks_dir", lambda: tmp_path)
    with pytest.raises(HTTPException) as ei:
        api.get_cowork_logo("a")
    assert ei.value.status_code == 404


def test_an_unknown_cowork_gives_404(tmp_path, monkeypatch):
    monkeypatch.setattr("netlivecowork.paths.coworks_dir", lambda: tmp_path)
    with pytest.raises(HTTPException) as ei:
        api.get_cowork_logo("nope")
    assert ei.value.status_code == 404


def test_an_oversized_logo_is_refused(tmp_path, monkeypatch):
    """装一张"不知道多大"的图，内存和界面都可能被一个坏包拖垮。"""
    d = _suite(tmp_path, "a")
    (d / "logo.png").write_bytes(b"0" * (api._LOGO_MAX_BYTES + 1))
    monkeypatch.setattr("netlivecowork.paths.coworks_dir", lambda: tmp_path)
    with pytest.raises(HTTPException) as ei:
        api.get_cowork_logo("a")
    assert ei.value.status_code == 413


def test_the_listing_only_advertises_a_logo_when_there_is_one(tmp_path, monkeypatch):
    """有就给地址、没有就给 None —— 前端据此决定画图还是画首字母。
    一律给地址的话，没 logo 的那些会先请求一次再 404，界面闪一下。"""
    _suite(tmp_path, "withlogo", files=["logo.svg"])
    _suite(tmp_path, "plain")
    monkeypatch.setattr("netlivecowork.paths.coworks_dir", lambda: tmp_path)
    got = {c.id: c.logo_url for c in api.list_coworks()}
    assert got["withlogo"] == "/api/v1/coworks/withlogo/logo"
    assert got["plain"] is None
