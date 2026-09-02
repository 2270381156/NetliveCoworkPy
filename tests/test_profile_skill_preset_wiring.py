"""profile 预置协调的接线：启动、W3 登录、recheck 三个入口用同一个协调器。

接线错了没有任何报错——只是"预置不出现 / 登录后才出现 / recheck 后该回收的没回收"，
而这三样都长得像数据问题。所以这里钉的是**调用顺序与入口**，不是协调逻辑本身
（那部分在 test_profile_skill_presets.py）。
"""
from __future__ import annotations

import inspect
from pathlib import Path
from unittest.mock import Mock

from netlivecowork.api import skills as skills_api
from netlivecowork.api.skills import CurrentUserRequest
from netlivecowork.bootstrap import host_runtime
from netlivecowork.providers.capability.skills.references.presets import ReconcileResult

SRC = Path(host_runtime.__file__).parent.parent


# ── 登录入口：POST /skills/current-user ───────────────────────────────────────

def test_current_user_reconciles_per_user_presets(monkeypatch):
    """设用户名 → 协调该用户预置 → 有变更才作废索引。顺序不能乱：
    先协调后作废，索引重建时看到的就是新引用集。"""
    calls: list = []
    monkeypatch.setattr(
        skills_api.current_user, "set_current_username",
        lambda u: calls.append(("user", u)),
    )

    def reconcile(u):
        calls.append(("preset", u))
        return ReconcileResult(changed=True)

    monkeypatch.setattr(skills_api, "_reconcile_profile_skill_presets", reconcile)
    monkeypatch.setattr(
        skills_api, "_mark_skill_index_dirty", lambda: calls.append(("dirty", None)),
    )
    skills_api.set_current_user(CurrentUserRequest(username="alice"))
    assert calls == [("user", "alice"), ("preset", "alice"), ("dirty", None)]


def test_current_user_does_not_dirty_index_when_reconcile_is_unchanged(monkeypatch):
    """协调无变更（幂等重登录）→ 不作废索引：白作废一次等于全量重建一遍 skill 索引。"""
    monkeypatch.setattr(
        skills_api, "_reconcile_profile_skill_presets",
        lambda _u: ReconcileResult(changed=False),
    )
    dirty = Mock()
    monkeypatch.setattr(skills_api, "_mark_skill_index_dirty", dirty)
    skills_api.set_current_user(CurrentUserRequest(username="alice"))
    dirty.assert_not_called()


# ── 启动入口：_register_skills ────────────────────────────────────────────────

def test_register_skills_reconciles_shared_presets_before_provider_registration():
    """共享来源的首次协调在引用 provider 注册**之前**——否则首个会话的能力清单
    停在协调前的快照，预置 skill 要到下一次作废才出现。"""
    src = inspect.getsource(host_runtime._register_skills)
    assert 'reconcile_profile_skill_presets("")' in src, "启动路径没协调共享来源的预置"
    assert src.index('reconcile_profile_skill_presets("")') < src.index(
        "register_capability(ReferencedSkillCapabilityProvider"
    ), "协调必须发生在引用 provider 注册之前"


def test_register_skills_uses_the_shared_store_facade():
    """host_runtime 不再自建第三个 store 实例——三处创建路径共用 deps 的缓存门面。"""
    src = inspect.getsource(host_runtime._register_skills)
    assert "SkillReferenceStore(" not in src, "应改用 deps.get_skill_reference_store()"
    assert "get_skill_reference_store()" in src


# ── recheck 入口：apply_cowork_state ──────────────────────────────────────────

def test_apply_cowork_state_reconciles_profile_presets():
    """recheck 与启动走同一个刷新清单；协调是清单里独立的一步，失败不连累其余。"""
    src = inspect.getsource(host_runtime.apply_cowork_state)
    assert "reconcile_profile_skill_presets()" in src, "刷新清单漏了预置协调"
    assert "_mark_skill_index_dirty" in src and "changed" in src, \
        "只有协调确有变更（原子提交成功）才作废 skill 索引"


def test_reconcile_helper_reads_current_user_when_username_is_none(monkeypatch):
    """recheck 路径（不传 username）→ 用当前 W3 用户协调按用户来源的预置。"""
    from netlivecowork.api import deps
    from netlivecowork.providers.capability.skills import current_user

    seen: dict = {}

    class FakeReconciler:
        def reconcile(self, profiles, username=""):
            seen["username"] = username
            seen["profiles"] = list(profiles)
            return ReconcileResult()

    class FakeProfile:
        id = "ipmaster"
        skill_presets = ()

    monkeypatch.setattr(
        deps, "get_profile_skill_preset_reconciler", lambda: FakeReconciler()
    )
    monkeypatch.setattr(
        "netlivecowork.cowork.installed.list_all", lambda d: [FakeProfile()]
    )
    current_user.set_current_username("alice")
    try:
        host_runtime.reconcile_profile_skill_presets()
    finally:
        current_user.set_current_username("")
    assert seen == {"username": "alice", "profiles": [seen["profiles"][0]]}
    assert seen["profiles"][0].id == "ipmaster"


# ── deps：一个 store 门面、市场服务带协调器 ────────────────────────────────────

def test_deps_share_one_reference_store():
    from netlivecowork.api import deps

    assert deps.get_skill_reference_store() is deps.get_skill_reference_store()
    svc = deps.get_skill_market_service()
    assert svc._store is deps.get_skill_reference_store(), \
        "市场服务要复用 deps 的 store 门面，不再自建"
    assert svc._presets is deps.get_profile_skill_preset_reconciler(), \
        "市场服务的手工引用要经协调器落库（清 opt-out）"
