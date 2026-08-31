"""档一（软要求）：skill 市场地址未配置时，主程序照常启动。

**指名要某一家**（上传只走 cowork）→ 仍然抛，且报错指向具体 env 键，用户看了知道该配哪个。
**聚合市场**（把认识的几家都装出来）→ 不再因为其中一家没配就整个失败：没配的跳过，配好的
照常工作。原先是 mythos 少配一行，cowork 也一起用不了，整个市场接口 500。
"""
import pytest

import netlivecowork.config as cfgmod
from netlivecowork.api import deps


@pytest.fixture(autouse=True)
def _reset_caches():
    # getter 用 lru_cache、settings 用模块级单例，前后都清干净避免跨用例串味。
    def _clear():
        cfgmod._settings = None
        deps.get_cowork_skill_service.cache_clear()
        deps.get_skill_market_service.cache_clear()

    _clear()
    yield
    _clear()


def test_cowork_service_unconfigured_raises(monkeypatch):
    monkeypatch.delenv("NLC_SKILL_PULL_SERVER_URL", raising=False)
    with pytest.raises(RuntimeError, match="NLC_SKILL_PULL_SERVER_URL"):
        deps.get_cowork_skill_service()


def test_market_service_drops_the_unconfigured_one_and_keeps_the_rest(monkeypatch):
    """pull 已配、mythos 缺 → 市场服务照常构造，只是少了 mythos 那一家。

    这条曾经断言"抛 RuntimeError"。改掉是因为那个抛法会顺着依赖注入炸到不相干的地方：
    ``GET /api/v1/skills``（已装 skill 列表）当时挂着 ``Depends(get_skill_market_service)``，
    于是 mythos 少配一行，整页 500，连本地的 pdf/pptx 也看不见。
    """
    monkeypatch.setenv("NLC_SKILL_PULL_SERVER_URL", "http://cowork.test/api")
    monkeypatch.delenv("NLC_SKILL_MYTHOS_BASE_URL", raising=False)

    svc = deps.get_skill_market_service()
    assert set(svc._adapters) == {"cowork"}


def test_market_service_survives_all_unconfigured(monkeypatch):
    """一家都没配也不抛：市场页空着，而不是把 500 甩给所有依赖它的接口。"""
    monkeypatch.delenv("NLC_SKILL_PULL_SERVER_URL", raising=False)
    monkeypatch.delenv("NLC_SKILL_MYTHOS_BASE_URL", raising=False)
    assert deps.get_skill_market_service()._adapters == {}
