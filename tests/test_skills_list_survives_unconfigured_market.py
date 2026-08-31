"""已装 skill 列表不该被"某家市场没配"拖垮 —— **走真实依赖注入**的回归测试。

事故经过：``GET /api/v1/skills`` 一度挂着 ``market=Depends(get_skill_market_service)``，
只为问一句"哪些市场按人可见"。而那个依赖在任一市场地址没配时抛 RuntimeError，FastAPI
又是**先解析完所有依赖才进函数体** —— 于是 mythos 少配一行，整页 500，连跟市场毫无关系
的本地 pdf/pptx 也一起看不见；输入框打 /技能名 静默失效（前端拿到 500 退化成空列表，
匹配不到就当普通文本发出去，不报错）。

**为什么原有测试没抓住**：tests/test_skills_routes.py 直接把 ``_FakeMarket()`` 传进路由
函数，绕开了依赖解析 —— 那正是出事的那一步。所以这里必须走 TestClient + 真实 deps，
一个 fake 都不放。
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import netlivecowork.config as cfgmod
from netlivecowork.api import deps
from netlivecowork.api import skills as skills_api


@pytest.fixture(autouse=True)
def _reset_caches():
    """deps 的 getter 用 lru_cache、settings 是模块级单例，前后都清干净。"""
    def _clear():
        cfgmod._settings = None
        for getter in (
            deps.get_local_skill_service,
            deps.get_skill_reference_store,
            deps.get_skill_market_service,
            deps.get_cowork_skill_service,
        ):
            getter.cache_clear()

    _clear()
    yield
    _clear()


@pytest.fixture
def env(tmp_path, monkeypatch):
    """一个只有本地 skill、没有任何云端引用的干净环境。"""
    skills = tmp_path / "skills"
    (skills / "pdf").mkdir(parents=True)
    (skills / "pdf" / "SKILL.md").write_text(
        "---\nname: pdf\ndescription: 读 PDF\n---\n\n正文\n", encoding="utf-8"
    )
    monkeypatch.setenv("NLC_SKILLS_DIR", str(skills))
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path / "data"))
    return tmp_path


def _client() -> TestClient:
    """只挂这一个端点，但**用真实的路由函数签名与真实依赖**。"""
    app = FastAPI()
    app.add_api_route("/skills", skills_api.list_local_skills, methods=["GET"])
    return TestClient(app, raise_server_exceptions=False)


def test_local_skills_still_listed_when_mythos_unconfigured(env, monkeypatch):
    """**事故那条**：mythos 地址为空（新装机器的出厂状态）时，列表照常返回。"""
    monkeypatch.setenv("NLC_SKILL_PULL_SERVER_URL", "http://cowork.test/api")
    monkeypatch.setenv("NLC_SKILL_MYTHOS_BASE_URL", "")

    r = _client().get("/skills")
    assert r.status_code == 200, f"这里曾经是 500：{r.text[:200]}"
    assert [s["skill_id"] for s in r.json()] == ["pdf"]


def test_local_skills_still_listed_when_no_market_configured_at_all(env, monkeypatch):
    """两家都没配也一样 —— 本地 skill 跟市场本来就没关系。"""
    monkeypatch.delenv("NLC_SKILL_PULL_SERVER_URL", raising=False)
    monkeypatch.delenv("NLC_SKILL_MYTHOS_BASE_URL", raising=False)

    r = _client().get("/skills")
    assert r.status_code == 200
    assert [s["skill_id"] for s in r.json()] == ["pdf"]


def test_endpoint_no_longer_depends_on_the_market_service(env):
    """从签名上钉死：这个接口不许再挂市场服务。

    只断言"返回 200"挡不住有人把 Depends 加回来又顺手加个 try —— 那样问题会以别的形态
    重现（比如可见性名单悄悄变空）。这里直接不让它出现在依赖里。
    """
    import inspect

    params = inspect.signature(skills_api.list_local_skills).parameters
    defaults = [p.default for p in params.values()]
    assert deps.get_skill_market_service not in [
        getattr(d, "dependency", None) for d in defaults
    ], "已装 skill 列表不该依赖市场服务：它在任一市场没配时构造即抛"


def test_mythos_reference_stays_hidden_from_other_users_even_when_unconfigured(env, monkeypatch):
    """**保守方向**：mythos 没配 ≠ 别人的 skill 变成人人可见。

    可见性名单若改从"活的市场服务"取，没配的那家就不在名单里，它的引用会被当成公开的
    —— 那是个放宽权限的错。名单来自静态表，所以这条成立。
    """
    from netlivecowork.providers.capability.skills import current_user
    from netlivecowork.providers.capability.skills.references.store import (
        SkillReference,
        SkillReferenceStore,
    )

    monkeypatch.setenv("NLC_SKILL_MYTHOS_BASE_URL", "")     # 那家没配
    store = SkillReferenceStore(env / "data")
    store.add_reference(SkillReference(
        source="mythos", remote_id="m1", name="别人的", description="d", owner="alice",
    ))

    current_user.set_current_username("bob")
    try:
        r = _client().get("/skills")
    finally:
        current_user.set_current_username("")

    assert r.status_code == 200
    assert [s["skill_id"] for s in r.json()] == ["pdf"], "alice 的 mythos skill 不该露给 bob"
