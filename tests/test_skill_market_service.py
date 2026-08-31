"""Skill marketplace: cowork + mythos source adapters and the merging market layer."""
from __future__ import annotations

import io
import zipfile

import httpx
import pytest

# 翻页那条测试 patch 模块级 _PAGE_SIZE 来逼出多页。
from netlivecowork.providers.capability.skills.adapters import MarketContext, MarketItem
from netlivecowork.providers.capability.skills.adapters import mythos as mythos_impl
from netlivecowork.providers.capability.skills.errors import SkillError
from netlivecowork.providers.capability.skills.services.market import SkillMarketService
from netlivecowork.providers.capability.skills.adapters.mythos import MythosMarketAdapter
from netlivecowork.providers.capability.skills.adapters.cowork import CoworkMarketAdapter
from netlivecowork.providers.capability.skills.references.store import SkillReference, SkillReferenceStore
from netlivecowork.providers.capability.skills.legacy import SkillPullStore


_MD = "---\nname: Remote Skill\ndescription: d\n---\nbody"
_MYTHOS = "https://mythos"
_DL = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/download"
_QUERY = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/query"


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("remote-skill/SKILL.md", _MD)
    return buf.getvalue()


def _resp(status=200, json_body=None, content=b"", url="http://x"):
    request = httpx.Request("GET", url)
    return httpx.Response(status, json=json_body, content=content if json_body is None else None, request=request)


class _FakeClient:
    """httpx.Client stand-in driven by a {(method, url): response} routes dict."""

    def __init__(self, routes):
        self._routes = routes

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        return self._routes[("GET", url)]

    def post(self, url, headers=None, files=None, json=None):
        return self._routes[("POST", url)]


def _market(tmp_path, cowork_url="http://srv/api", mythos_url=_MYTHOS) -> tuple[SkillMarketService, SkillReferenceStore]:
    store = SkillReferenceStore(tmp_path / "data")
    svc = SkillMarketService(
        adapters=[
            CoworkMarketAdapter(server_url=cowork_url),
            # 缓存关掉：这些用例要逐次控制返回，缓存会让第二次拿到上一次的结果。
            MythosMarketAdapter(base_url=mythos_url, cache_ttl_sec=0),
        ],
        store=store,
    )
    return svc, store


# ── cowork source adapter ─────────────────────────────────────────────────────

def test_cowork_list_catalog_normalises(monkeypatch):
    routes = {("GET", "http://srv/api/skills"): _resp(
        200, json_body=[
            {"id": "r1", "name": "A", "description": "da", "createTime": "t1", "updater": "u"},
            {"id": 2, "name": "B"},
        ],
    )}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    items = CoworkMarketAdapter("http://srv/api").list_catalog(MarketContext())
    by_id = {i.id: i for i in items}
    assert by_id["r1"].create_time == "t1"
    assert by_id["2"].id == "2"            # ids coerced to str
    assert by_id["2"].description is None


def test_cowork_not_configured():
    with pytest.raises(SkillError) as e:
        CoworkMarketAdapter("").list_catalog(MarketContext())
    assert e.value.code == "PULL_SERVER_NOT_CONFIGURED"


def test_import_to_remote_ok(monkeypatch):
    routes = {("POST", "http://srv/api/skills/import"): _resp(200, json_body={"id": "new1", "name": "N"})}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    out = CoworkMarketAdapter("http://srv/api").import_to_remote(b"zipbytes", "skill.zip", MarketContext())
    assert out == {"skill_id": "new1", "name": "N"}


def test_import_to_remote_forwards_auth_header(monkeypatch):
    # 带 auth_header 时，原样作为 Authorization 转发给 cowork（→ cowork 写 creator）。
    captured = {}

    class _CapturingClient:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, files=None, json=None):
            captured["headers"] = headers
            return _resp(200, json_body={"id": "n", "name": "N"})

    monkeypatch.setattr(httpx, "Client", lambda **kw: _CapturingClient())
    CoworkMarketAdapter("http://srv/api").import_to_remote(b"z", "s.zip", MarketContext(auth_header="Bearer tok123"))
    assert captured["headers"]["Authorization"] == "Bearer tok123"


def test_import_to_remote_no_auth_header_when_absent(monkeypatch):
    captured = {}

    class _CapturingClient:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, files=None, json=None):
            captured["headers"] = headers
            return _resp(200, json_body={"id": "n", "name": "N"})

    monkeypatch.setattr(httpx, "Client", lambda **kw: _CapturingClient())
    CoworkMarketAdapter("http://srv/api").import_to_remote(b"z", "s.zip", MarketContext())
    assert "Authorization" not in captured["headers"]


# ── mythos source adapter ─────────────────────────────────────────────────────

class _PagingClient:
    """Serves the mythos query API from an in-memory dataset, honoring start/limit."""

    def __init__(self, dataset):
        self._data = dataset

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, headers=None, files=None, json=None):
        start, limit = json["start"], json["limit"]
        page = self._data[start:start + limit]
        return _resp(200, json_body={"total": len(self._data), "data": page})

    def get(self, url, headers=None):
        raise AssertionError("unexpected GET")


def test_mythos_list_catalog_pages_through_all(monkeypatch):
    monkeypatch.setattr(mythos_impl, "_PAGE_SIZE", 2)  # force multiple pages
    dataset = [
        {"skill_id": i, "skill_name": f"S{i}",
         "display_name": {"default": f"显示名{i}", "zh_CN": "", "en_US": ""},
         "description": {"default": f"d{i}"}, "tag_names": ["IPmaster_Baseline"],
         "updater": "c30025961", "updated_time": f"t{i}"}
        for i in range(5)
    ]
    monkeypatch.setattr(httpx, "Client", lambda **kw: _PagingClient(dataset))
    items = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=0).list_catalog(MarketContext(username="a001"))
    assert len(items) == 5                       # all pages assembled
    # name 取 display_name.default，非 skill_name
    assert items[0] == MarketItem(
        id="0", name="显示名0", description="d0", updater="c30025961", create_time="t0",
    )


def test_mythos_name_falls_back_to_skill_name(monkeypatch):
    # display_name 缺失/为空时退回 skill_name。
    dataset = [{"skill_id": 1, "skill_name": "fallback-name",
                "display_name": {"default": "", "zh_CN": "", "en_US": ""},
                "description": {"default": "d"}, "tag_names": ["IPmaster_Baseline"], "updated_time": "t"}]
    monkeypatch.setattr(httpx, "Client", lambda **kw: _PagingClient(dataset))
    items = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=0).list_catalog(MarketContext(username="a001"))
    assert items[0].name == "fallback-name"


def test_mythos_list_catalog_filters_by_baseline_tag(monkeypatch):
    # 只保留 tag_names 含 IPmaster_Baseline 的 skill（可同时带其它 tag）。
    routes = {("POST", f"{_MYTHOS}{_QUERY}"): _resp(200, json_body={"total": 3, "data": [
        {"skill_id": 1, "display_name": {"default": "A"}, "tag_names": ["IPmaster_Baseline"], "updated_time": "t1"},
        {"skill_id": 2, "display_name": {"default": "测试"}, "tag_names": ["other"], "updated_time": "t2"},
        {"skill_id": 3, "display_name": {"default": "C"}, "tag_names": ["foo", "IPmaster_Baseline"], "updated_time": "t3"},
        {"skill_id": 4, "display_name": {"default": "无tag"}, "tag_names": [], "updated_time": "t4"},
    ]})}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    items = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=0).list_catalog(MarketContext(username="a001"))
    assert {it.id for it in items} == {"1", "3"}   # 2(无baseline)、4(无tag) 被过滤


def test_mythos_download_empty_content_raises(monkeypatch):
    # 部分 mythos skill 的 id 没有内容：服务端返回 200 但 body 为空/非 zip。
    routes = {("GET", f"{_MYTHOS}{_DL}/9"): _resp(200, content=b"")}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).download_zip("9", MarketContext(username="a001"))
    assert e.value.code == "MYTHOS_SKILL_EMPTY"


def test_mythos_download_non_zip_raises(monkeypatch):
    routes = {("GET", f"{_MYTHOS}{_DL}/9"): _resp(200, content=b"<html>not a zip</html>")}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).download_zip("9", MarketContext(username="a001"))
    assert e.value.code == "MYTHOS_SKILL_EMPTY"


def test_mythos_failure_raises(monkeypatch):
    routes = {("POST", f"{_MYTHOS}{_QUERY}"): _resp(500, content=b"boom")}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS, cache_ttl_sec=0).list_catalog(MarketContext(username="a001"))
    assert e.value.code == "MYTHOS_ERROR"


# ── market layer: merge / degrade / pull dispatch ─────────────────────────────

def test_catalog_merges_both_sources_and_tags(tmp_path, monkeypatch):
    svc, store = _market(tmp_path)
    store.add_reference(SkillReference(source="mythos", remote_id="9", name="Myth", owner="a001"))   # 已引用
    routes = {
        ("GET", "http://srv/api/skills"): _resp(200, json_body=[{"id": "c1", "name": "Cow", "createTime": "t1"}]),
        ("POST", f"{_MYTHOS}{_QUERY}"): _resp(200, json_body={"total": 1, "data": [
            {"skill_id": 9, "skill_name": "Myth", "description": {"default": "d"},
             "tag_names": ["IPmaster_Baseline"], "updated_time": "t2"},
        ]}),
    }
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))

    items = svc.catalog("a001")
    by_src = {i["source"]: i for i in items}
    assert set(by_src) == {"cowork", "mythos"}
    assert by_src["cowork"]["is_pulled"] is False
    assert by_src["mythos"]["is_pulled"] is True          # namespaced key matched
    assert items[0]["source"] == "mythos"                 # t2 > t1, desc sort


def test_catalog_degrades_to_cowork_when_mythos_fails(tmp_path, monkeypatch):
    svc, _ = _market(tmp_path)
    routes = {
        ("GET", "http://srv/api/skills"): _resp(200, json_body=[{"id": "c1", "name": "Cow"}]),
        ("POST", f"{_MYTHOS}{_QUERY}"): _resp(503, content=b"down"),
    }
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    items = svc.catalog("a001")
    assert [i["source"] for i in items] == ["cowork"]     # mythos skipped, cowork still shows


def test_pull_dispatches_by_source_and_records(tmp_path, monkeypatch):
    svc, store = _market(tmp_path)
    routes = {
        ("GET", f"{_MYTHOS}{_DL}/9"): _resp(200, content=_zip_bytes()),
        ("GET", "http://srv/api/skills/r9/export"): _resp(200, content=_zip_bytes()),
    }
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))

    # 引用式：下载一次抽元数据 → 存引用（不解压到 skills_dir）。mythos 记 owner=当前用户。
    out = svc.pull("mythos", "9", "Remote Skill", "a001")
    assert out == {"skill_id": "mythos:9", "name": "Remote Skill"}
    assert not (tmp_path / "skills").exists()            # 不再解压到本地
    ref = store.get_reference("mythos", "9")
    assert ref is not None and ref.name == "Remote Skill" and ref.owner == "a001"

    svc.pull("cowork", "r9", "Remote Skill", "")
    assert store.is_referenced("cowork", "r9")
    assert store.get_reference("cowork", "r9").owner is None   # cowork 不记 owner


def test_pull_unknown_source_raises(tmp_path):
    svc, _ = _market(tmp_path)
    with pytest.raises(SkillError) as e:
        svc.pull("bogus", "1", "X", "a001")
    assert e.value.code == "UNKNOWN_SOURCE"


def test_pull_404_maps_to_not_found(tmp_path, monkeypatch):
    svc, _ = _market(tmp_path)
    routes = {("GET", "http://srv/api/skills/rx/export"): _resp(404, content=b"nope")}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))
    with pytest.raises(SkillError) as e:
        svc.pull("cowork", "rx", "Whatever", "")
    assert e.value.code == "REMOTE_SKILL_NOT_FOUND"


# ── store: legacy key migration ───────────────────────────────────────────────

def test_store_migrates_legacy_unprefixed_keys(tmp_path):
    import json
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "skill_pull_config.json").write_text(
        json.dumps({"pulled": {"r1": "folder-a"}}), encoding="utf-8")
    store = SkillPullStore(data_dir)
    assert store.get_pulled_map() == {"cowork:r1": "folder-a"}   # legacy → cowork namespace
    assert store.is_pulled("cowork", "r1")
