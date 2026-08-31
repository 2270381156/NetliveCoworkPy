"""两家市场 adapter 的直接测试（重构第 2 步）。

本文件测两家 adapter 本身：契约方法、各自的方言（翻页/鉴权/过滤/缓存）、以及
归一后的 MarketItem。

市场层怎么把两家合起来，在 tests/test_skill_market_service.py。
"""

from __future__ import annotations

import io
import json
import zipfile

import httpx
import pytest

from netlivecowork.providers.capability.skills.adapters import MarketContext, MarketItem
from netlivecowork.providers.capability.skills.adapters.base import (
    VISIBILITY_EVERYONE,
    VISIBILITY_PER_USER,
)
from netlivecowork.providers.capability.skills.adapters.cowork import CoworkMarketAdapter
from netlivecowork.providers.capability.skills.adapters.mythos import MythosMarketAdapter
from netlivecowork.providers.capability.skills.errors import SkillError

_COWORK = "http://srv/api"
_MYTHOS = "http://mythos"


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("s/SKILL.md", "---\nname: s\n---\n")
    return buf.getvalue()


def _mock(monkeypatch, handler):
    """把 httpx.Client 的 get/post 换成 handler(method, url, **kw) -> httpx.Response。"""

    class _C:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, **kw): return handler("GET", url, **kw)
        def post(self, url, **kw): return handler("POST", url, **kw)

    monkeypatch.setattr(httpx, "Client", _C)


def _resp(status=200, *, json_body=None, content=b"", request_url="http://x"):
    return httpx.Response(
        status,
        json=json_body,
        content=None if json_body is not None else content,
        request=httpx.Request("GET", request_url),
    )


# ── cowork ────────────────────────────────────────────────────────────────────


def test_cowork_returns_market_items(monkeypatch):
    """返回的是 MarketItem，不是 dict —— 上层从此不必知道各家的原始字段名。"""
    _mock(monkeypatch, lambda m, u, **k: _resp(json_body=[
        {"id": 7, "name": "写文档", "description": "d", "updater": "u", "createTime": "2026-01-01"},
    ]))
    items = CoworkMarketAdapter(_COWORK).list_catalog(MarketContext())
    assert items == [MarketItem(id="7", name="写文档", description="d",
                               updater="u", create_time="2026-01-01")]
    assert isinstance(items[0].id, str)      # id 统一成字符串，源里是数字


def test_cowork_ignores_username_in_context(monkeypatch):
    """cowork 不需要用户名。**上下文里有它也不该影响结果**——这正是统一签名的意义。"""
    seen = {}

    def h(m, u, **k):
        seen["headers"] = k.get("headers") or {}
        return _resp(json_body=[])

    _mock(monkeypatch, h)
    CoworkMarketAdapter(_COWORK).list_catalog(MarketContext(username="zhang"))
    assert "x-cse-context" not in seen["headers"]
    assert "Authorization" not in seen["headers"]


def test_cowork_upload_uses_auth_header_from_context(monkeypatch):
    seen = {}

    def h(m, u, **k):
        seen["headers"] = k.get("headers") or {}
        return _resp(json_body={"id": "1", "name": "s"})

    _mock(monkeypatch, h)
    out = CoworkMarketAdapter(_COWORK).import_to_remote(
        b"z", "s.zip", MarketContext(auth_header="Bearer tok"))
    assert out == {"skill_id": "1", "name": "s"}
    assert seen["headers"]["Authorization"] == "Bearer tok"


def test_cowork_visibility_is_everyone():
    assert CoworkMarketAdapter(_COWORK).visibility == VISIBILITY_EVERYONE


def test_cowork_unconfigured_keeps_the_original_code():
    """错误码是前端分支依据，搬家时改一个字都算换 API。"""
    with pytest.raises(SkillError) as e:
        CoworkMarketAdapter("").list_catalog(MarketContext())
    assert e.value.code == "PULL_SERVER_NOT_CONFIGURED"


# ── mythos ────────────────────────────────────────────────────────────────────


def test_mythos_pages_internally_and_returns_one_list(monkeypatch):
    """**契约的核心**：上层拿到一整份，不知道这里翻了几页。"""
    import netlivecowork.providers.capability.skills.adapters.mythos as mod
    monkeypatch.setattr(mod, "_PAGE_SIZE", 2)

    pages = [
        {"total": 3, "data": [_m(1), _m(2)]},
        {"total": 3, "data": [_m(3)]},
    ]
    calls = {"n": 0}

    def h(m, u, **k):
        body = pages[calls["n"]]
        calls["n"] += 1
        return _resp(json_body=body)

    _mock(monkeypatch, h)
    items = MythosMarketAdapter(_MYTHOS).list_catalog(MarketContext(username="a001"))
    assert [it.id for it in items] == ["1", "2", "3"]
    assert calls["n"] == 2                   # 确实翻了两页


def _m(i: int, *, baseline=True, display=True) -> dict:
    return {
        "skill_id": i,
        "skill_name": f"raw{i}",
        "display_name": {"default": f"名{i}"} if display else None,
        "description": {"default": f"述{i}"},
        "updater": "u",
        "updated_time": "2026-01-01",
        "tag_names": ["IPmaster_Baseline"] if baseline else ["other"],
    }


def test_mythos_filters_non_baseline(monkeypatch):
    _mock(monkeypatch, lambda m, u, **k: _resp(json_body={
        "total": 2, "data": [_m(1), _m(2, baseline=False)]}))
    items = MythosMarketAdapter(_MYTHOS).list_catalog(MarketContext(username="a001"))
    assert [it.id for it in items] == ["1"]


def test_mythos_name_falls_back_to_skill_name(monkeypatch):
    _mock(monkeypatch, lambda m, u, **k: _resp(json_body={
        "total": 1, "data": [_m(1, display=False)]}))
    items = MythosMarketAdapter(_MYTHOS).list_catalog(MarketContext(username="a001"))
    assert items[0].name == "raw1"


def test_mythos_sends_username_in_auth_header(monkeypatch):
    seen = {}

    def h(m, u, **k):
        seen["headers"] = k.get("headers") or {}
        return _resp(json_body={"total": 0, "data": []})

    _mock(monkeypatch, h)
    MythosMarketAdapter(_MYTHOS).list_catalog(MarketContext(username="a001"))
    ctx = json.loads(seen["headers"]["x-cse-context"])
    assert ctx["x-gde-username"] == "a001"
    assert ctx["x-gde-tenant-id"] == "2000"


def test_mythos_download_rejects_non_zip(monkeypatch):
    """服务端对某些 id 返回 200 但 body 不是 zip。要在这里说清，别崩在后面解压。"""
    _mock(monkeypatch, lambda m, u, **k: _resp(content=b"not a zip"))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).download_zip("9", MarketContext(username="a001"))
    assert e.value.code == "MYTHOS_SKILL_EMPTY"


def test_mythos_download_ok(monkeypatch):
    _mock(monkeypatch, lambda m, u, **k: _resp(content=_zip_bytes()))
    out = MythosMarketAdapter(_MYTHOS).download_zip("9", MarketContext(username="a001"))
    assert zipfile.is_zipfile(io.BytesIO(out))


def test_mythos_visibility_is_per_user():
    """这条取代了 reference_store 里那句 if ref.source == "mythos"。"""
    assert MythosMarketAdapter(_MYTHOS).visibility == VISIBILITY_PER_USER


def test_mythos_upload_is_unsupported():
    """mythos 不支持上传，走基类默认——不必让它实现一个注定失败的方法。"""
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).import_to_remote(b"z", "s.zip", MarketContext())
    assert e.value.code == "UNSUPPORTED"
    assert "mythos" in str(e.value)


# ── 两家一起看 ────────────────────────────────────────────────────────────────


def test_both_answer_the_same_calls():
    """同一组签名喂给两家都成立——这是"上层不必分支"的前提。"""
    for a in (CoworkMarketAdapter(_COWORK), MythosMarketAdapter(_MYTHOS)):
        assert callable(a.list_catalog) and callable(a.download_zip)
        assert a.name in {"cowork", "mythos"}
        assert a.visibility in {VISIBILITY_EVERYONE, VISIBILITY_PER_USER}


# ── 缓存与前置条件（第 3 步下沉进来的）──────────────────────────────────────────
#
# 这两样原先在市场层：一个只给 mythos 的缓存字典，一句 "username 为空就跳过"。
# 它们是这一家的实现细节——翻页要打好几个来回所以要缓存，鉴权头要用户名所以缺了就失败。
# 放在市场层等于让上层知道"哪家慢、哪家有什么脾气"。


def test_mythos_caches_within_ttl(monkeypatch):
    calls = {"n": 0}

    def h(m, u, **k):
        calls["n"] += 1
        return _resp(json_body={"total": 1, "data": [_m(1)]})

    _mock(monkeypatch, h)
    a = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=60)
    ctx = MarketContext(username="a001")
    assert len(a.list_catalog(ctx)) == 1
    assert len(a.list_catalog(ctx)) == 1
    assert calls["n"] == 1, "第二次应当命中缓存，不该再打网络"


def test_mythos_cache_expires(monkeypatch):
    calls = {"n": 0}

    def h(m, u, **k):
        calls["n"] += 1
        return _resp(json_body={"total": 1, "data": [_m(1)]})

    _mock(monkeypatch, h)
    a = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=0)      # 立即过期
    ctx = MarketContext(username="a001")
    a.list_catalog(ctx)
    a.list_catalog(ctx)
    assert calls["n"] == 2


def test_mythos_cache_is_per_user(monkeypatch):
    """**不同用户看见的目录不同，缓存必须分桶**——共用一份就是串号，而且不报错。"""
    seen = []

    def h(m, u, **k):
        ctxhdr = json.loads((k.get("headers") or {})["x-cse-context"])
        seen.append(ctxhdr["x-gde-username"])
        return _resp(json_body={"total": 1, "data": [_m(1)]})

    _mock(monkeypatch, h)
    a = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=60)
    a.list_catalog(MarketContext(username="zhang"))
    a.list_catalog(MarketContext(username="li"))
    a.list_catalog(MarketContext(username="zhang"))     # 该命中缓存
    assert seen == ["zhang", "li"]


def test_mythos_cache_returns_a_copy(monkeypatch):
    """调用方会对结果排序、加 source/is_pulled 字段——改到缓存里就污染了下一次。"""
    _mock(monkeypatch, lambda m, u, **k: _resp(json_body={"total": 2, "data": [_m(1), _m(2)]}))
    a = MythosMarketAdapter(_MYTHOS, cache_ttl_sec=60)
    ctx = MarketContext(username="a001")
    first = a.list_catalog(ctx)
    first.clear()                                       # 模拟调用方就地改列表
    assert len(a.list_catalog(ctx)) == 2


def test_mythos_requires_username(monkeypatch):
    """这家的前置条件由它自己提，不再让市场层替它把关。"""
    _mock(monkeypatch, lambda m, u, **k: _resp(json_body={"total": 0, "data": []}))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).list_catalog(MarketContext())
    assert e.value.code == "MYTHOS_NO_USERNAME"


def test_mythos_download_also_requires_username(monkeypatch):
    _mock(monkeypatch, lambda m, u, **k: _resp(content=_zip_bytes()))
    with pytest.raises(SkillError) as e:
        MythosMarketAdapter(_MYTHOS).download_zip("9", MarketContext())
    assert e.value.code == "MYTHOS_NO_USERNAME"


def test_cowork_has_no_cache(monkeypatch):
    """cowork 一次取回全量，不需要缓存 —— 每次都该是新鲜的。"""
    calls = {"n": 0}

    def h(m, u, **k):
        calls["n"] += 1
        return _resp(json_body=[])

    _mock(monkeypatch, h)
    a = CoworkMarketAdapter(_COWORK)
    a.list_catalog(MarketContext())
    a.list_catalog(MarketContext())
    assert calls["n"] == 2
