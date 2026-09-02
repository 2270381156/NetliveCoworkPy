"""云端 skill 引用式加载：引用库 / 迁移 / materialize / 引用 provider（多用户 + 降级）。"""
from __future__ import annotations

import asyncio
import io
import json
import zipfile

import pytest

from ctx_weft.protocols.context import ProviderContext
from netlivecowork.providers.capability.skills.runtime import materialize
from netlivecowork.providers.capability.skills.legacy import migrate_pulled_to_references
from netlivecowork.providers.capability.skills.adapters.scopes import GENERAL_SCOPE
from netlivecowork.providers.capability.skills.references.store import (
    ANY_LABEL,
    ReferenceIdentity,
    SkillReference,
    SkillReferenceStore,
)
from netlivecowork.providers.capability.skills.provider import ReferencedSkillCapabilityProvider
from netlivecowork.providers.capability.skills.runtime.reporting import (
    consume_skill_own_reporting,
    detect_own_datalink_reporting,
    normalize_skill_name,
)
from netlivecowork.providers.capability.skills.legacy import SkillPullStore


def _zip(name: str, desc: str = "d", extra: dict | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("SKILL.md", f"---\nname: {name}\ndescription: {desc}\n---\n# use {name}\n")
        for path, content in (extra or {}).items():
            z.writestr(path, content)
    return buf.getvalue()


class _FakeMarket:
    def __init__(self, zips: dict[str, bytes] | None = None, fail: bool = False):
        self._zips = zips or {}
        self._fail = fail

    def download_zip(self, source, remote_id, username):
        if self._fail:
            from netlivecowork.providers.capability.skills.errors import SkillError
            raise SkillError("MYTHOS_UNREACHABLE", "云端不可达")
        return self._zips.get(f"{source}:{remote_id}", _zip("demo"))

    def per_user_sources(self):
        # 真实实现问各家 adapter 要（见 SkillMarketService）。这里固定 mythos，
        # 与这些用例的数据一致。
        return {"mythos"}


# ── 引用库 list_visible 过滤 ────────────────────────────────────────────────────

def test_reference_store_list_visible_filters_mythos_by_owner(tmp_path):
    s = SkillReferenceStore(tmp_path)
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1", "alice"), name="a"))
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "2", "bob"), name="b"))
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "3"), name="legacy"))  # 旧数据
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "4"), name="pub"))     # 公开
    names = lambda u: sorted(r.name for r in s.list_visible(u, {"mythos"}))
    assert names("alice") == ["a", "legacy", "pub"]   # bob 的隐藏；legacy(owner空)+cowork 都可见
    assert names("bob") == ["b", "legacy", "pub"]


# ── 迁移 ───────────────────────────────────────────────────────────────────────

def test_migrate_pulled_to_references(tmp_path):
    data_dir = tmp_path / "data"
    skills_dir = tmp_path / "skills"
    # 造一个"已安装的市场 skill"：skills_dir 里有文件夹 + pull store 记录
    folder = skills_dir / "myskill"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text("---\nname: MySkill\ndescription: d\n---\nbody", encoding="utf-8")
    pull = SkillPullStore(data_dir)
    pull.record_pulled("cowork", "c1", "myskill")
    ref = SkillReferenceStore(data_dir)

    n = migrate_pulled_to_references(pull, ref, skills_dir)
    assert n == 1
    r = ref.get_reference("cowork", "c1")
    assert r is not None and r.name == "MySkill"
    assert not folder.exists()                 # 本地文件已删
    assert pull.get_pulled_map() == {}         # pull store 已清
    assert migrate_pulled_to_references(pull, ref, skills_dir) == 0   # 幂等


def test_prune_null_references(tmp_path):
    """删除 description 为空的坏引用；有 description 的保留。"""
    from netlivecowork.providers.capability.skills.references.defaults import prune_null_references
    ref = SkillReferenceStore(tmp_path / "data")
    ref.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "a"), name="A", description=None))
    ref.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "b"), name="B", description="  "))   # 空白也算空
    ref.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "c"), name="C", description="real"))

    n = prune_null_references(ref)
    assert n == 2
    left = sorted(r.name for r in ref.list_references())
    assert left == ["C"]                            # 只留有描述的


def test_migrate_skips_broken_skill(tmp_path):
    """本地 SKILL.md 缺失（安装的这份坏了）→ 不迁移、不写 null 引用；清理残留 + pull 记录。"""
    data_dir = tmp_path / "data"
    skills_dir = tmp_path / "skills"
    folder = skills_dir / "broken"
    folder.mkdir(parents=True)                     # 有文件夹但没有 SKILL.md
    pull = SkillPullStore(data_dir)
    pull.record_pulled("cowork", "b1", "broken")
    ref = SkillReferenceStore(data_dir)

    n = migrate_pulled_to_references(pull, ref, skills_dir)
    assert n == 0                                  # 跳过，不算迁移
    assert ref.get_reference("cowork", "b1") is None   # 绝不写 null 引用
    assert not folder.exists()                     # 损坏残留已清
    assert pull.get_pulled_map() == {}             # pull 记录已清（不再重试）


def test_migrate_broken_keeps_existing_good_reference(tmp_path):
    """本地坏了但库里已有好引用 → 保留不动，不被覆盖成 null。"""
    data_dir = tmp_path / "data"
    skills_dir = tmp_path / "skills"
    (skills_dir / "broken").mkdir(parents=True)    # 无 SKILL.md
    pull = SkillPullStore(data_dir)
    pull.record_pulled("cowork", "g1", "broken")
    ref = SkillReferenceStore(data_dir)
    ref.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "g1"), name="Good", description="real desc"))

    migrate_pulled_to_references(pull, ref, skills_dir)
    r = ref.get_reference("cowork", "g1")
    assert r is not None and r.description == "real desc"   # 好引用保留


# ── materialize 清理 ───────────────────────────────────────────────────────────

def test_materialized_cleans_up():
    with materialize.materialized(_zip("x"), session_id="t1") as work:
        assert (work / "SKILL.md").exists()
    assert not work.exists()
    materialize.sweep_session("t1")


# ── 引用 provider：多用户 + materialize + 降级 ──────────────────────────────────

def test_referenced_provider_filters_and_materializes(tmp_path):
    store = SkillReferenceStore(tmp_path)
    store.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1", "alice"), name="demo", description="a"))
    store.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "2", "bob"), name="secret"))
    cur = {"u": "alice"}
    market = _FakeMarket({"mythos:1": _zip("demo", extra={"scripts/run.py": "print('hi')"})})
    p = ReferencedSkillCapabilityProvider(store, market, current_username_fn=lambda: cur["u"])
    ctx = ProviderContext(session_id="s1")

    async def go():
        caps = await p.list(ctx)
        assert sorted(c.name for c in caps) == ["demo"]           # alice 只看到自己的
        cur["u"] = "bob"
        assert sorted(c.name for c in (await p.list(ctx))) == ["secret"]
        cur["u"] = "alice"
        d = await p.load_definition("demo", ctx)
        assert d and "use demo" in d.instructions                 # materialize 读到指令
    asyncio.run(go())
    # 无残留
    root = materialize.temp_root() / "s1"
    assert not root.exists() or not list(root.glob("*/d/SKILL.md"))


def test_referenced_provider_none_description_coalesced(tmp_path):
    # 回归：引用库允许 description 为 null（存储格式 + market 把空描述写成 None）。
    # 未 coalesce 时 SkillCapability.description=None 会经 CapabilitySource 落成
    # ContextBlock.content=None，装配期 content_to_text(None) 崩溃（'NoneType' object is
    # not iterable）。这里断言 provider 出的 cap 描述已归一为 ""，且经 CapabilitySource
    # 渲染的 block.content 不为 None。
    from types import SimpleNamespace

    from ctx_weft.core.assembler.sources.capability import CapabilitySource
    from ctx_weft.core.utils import content_to_text

    store = SkillReferenceStore(tmp_path)
    store.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "1"), name="nodesc", description=None))
    p = ReferencedSkillCapabilityProvider(store, _FakeMarket(), current_username_fn=lambda: "alice")
    ctx = ProviderContext(session_id="s1")

    async def go():
        cap = (await p.list(ctx))[0]
        assert cap.description == ""            # None 已归一，不再泄进装配层
        # token_counter：内核 assembler 用它给每个能力块估 token 数（新版内核必需）。测试给 len 即可。
        request = SimpleNamespace(bound_capabilities=[cap], purpose="act", token_counter=len)
        blocks = [b async for b in CapabilitySource().fetch(request, deps=None)]
        assert blocks and blocks[0].content is not None
        assert content_to_text(blocks[0].content) == ""   # 渲染不崩
    asyncio.run(go())


def test_download_retries(tmp_path):
    from netlivecowork.providers.capability.skills.services.market import SkillMarketService
    from netlivecowork.providers.capability.skills.errors import SkillError

    from netlivecowork.providers.capability.skills.adapters.base import SkillMarketAdapter

    class FlakyAdapter(SkillMarketAdapter):
        """按 fails 次数先失败再成功。走公开契约，不再捅市场层的私有属性——
        第 4 步把 _cowork/_mythos 换成了 _adapters，捅私有的写法当场就废了。"""
        name = "mythos"

        def __init__(self, fails, code):
            self.n, self.fails, self.code = 0, fails, code

        def list_catalog(self, ctx):
            return []

        def download_zip(self, remote_id, ctx):
            self.n += 1
            if self.n <= self.fails:
                raise SkillError(self.code, "err")
            return b"ZIP"

    def mk(fails, code, retries=2):
        a = FlakyAdapter(fails, code)
        m = SkillMarketService(
            adapters=[a], store=None,
            download_retries=retries, download_retry_delay_sec=0.0,
        )
        return m, a

    # 失败 2 次后成功 → 共 3 次尝试
    m, a = mk(2, "MYTHOS_UNREACHABLE")
    assert m.download_zip("mythos", "1", "u") == b"ZIP"
    assert a.n == 3
    # 一直失败 → retries+1 次后抛（任何错误码都重试）
    m, a = mk(99, "REMOTE_SKILL_NOT_FOUND")
    with pytest.raises(SkillError):
        m.download_zip("mythos", "1", "u")
    assert a.n == 3


def test_referenced_provider_offline_degrades(tmp_path):
    store = SkillReferenceStore(tmp_path)
    store.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1", "alice"), name="demo"))
    p = ReferencedSkillCapabilityProvider(store, _FakeMarket(fail=True), current_username_fn=lambda: "alice")
    ctx = ProviderContext(session_id="s1")

    async def go():
        d = await p.load_definition("demo", ctx)      # 下载失败 → 返回说明，不抛
        assert d is not None and "无法加载" in d.instructions
        msg = await p.load_resource("demo", "ref.md", ctx)
        assert "无法加载" in msg
    asyncio.run(go())


def test_reporting_detection_requires_specific_datalink_evidence(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "business.py").write_text("client.saveEntity(payload)", encoding="utf-8")
    assert detect_own_datalink_reporting(tmp_path) is False

    (scripts / "report.py").write_text(
        "url = DATALINK_BASE_URL + '/saveEntity'\nheaders = {'Datalink-Sign': sign}\n",
        encoding="utf-8",
    )
    assert detect_own_datalink_reporting(tmp_path) is True

    # Keep compatibility with existing skills which embed the legacy service
    # URL directly instead of using DATALINK_* environment variables.
    (scripts / "report.py").write_text(
        "URL = 'https://snic.example/datalinkprobackend/aksk/formentity/'",
        encoding="utf-8",
    )
    assert detect_own_datalink_reporting(tmp_path) is True


def test_referenced_provider_captures_reporting_before_temp_cleanup(tmp_path):
    store = SkillReferenceStore(tmp_path)
    store.add_reference(
        SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1", "alice"), name="demo")
    )
    market = _FakeMarket(
        {
            "mythos:1": _zip(
                "demo",
                extra={
                    "scripts/report.py": (
                        "URL = 'https://host/data-api-service/api/datalist/saveEntity'\n"
                    )
                },
            )
        }
    )
    provider = ReferencedSkillCapabilityProvider(
        store, market, current_username_fn=lambda: "alice"
    )
    ctx = ProviderContext(session_id="report-session", task_id="report-task")

    async def go():
        definition = await provider.load_definition("demo", ctx)
        assert definition is not None

    asyncio.run(go())

    # The materialized directory has already been removed, but the task-scoped
    # decision remains available exactly once to SkillReporter.
    assert consume_skill_own_reporting(
        "report-session", "report-task", "cloud_skill__demo"
    ) is True
    assert consume_skill_own_reporting(
        "report-session", "report-task", "demo"
    ) is False


def test_reporting_skill_name_normalization():
    assert normalize_skill_name("cloud_skill__demo") == "demo"
    assert normalize_skill_name("local_skill__demo") == "demo"
    assert normalize_skill_name("cloud_skill__local_skill__demo") == "demo"
    assert normalize_skill_name("demo") == "demo"


def test_provider_description_states_usage_rules() -> None:
    """cloud_skill 的组描述与 local_skill 同一口径：skill 不是可调用工具、只能经
    delegate_task 绑到任务上触发、skill 自带文件只走 skill_executor 工具。"""
    desc = ReferencedSkillCapabilityProvider.description
    for frag in (
        "control__delegate_task",
        "skill_name",
        "cloud_skill__",
        "skill_executor__read_file",
        "skill_executor__list_files",
        "skill_executor__exec_script",
    ):
        assert frag in desc, f"组描述须点名 {frag}；实得 {desc!r}"
    low = desc.lower()
    assert "shell" in low and "filesystem" in low, \
        "须明确禁止拿 filesystem / shell 工具去操作 skill 文件"


# ── 可见性判断已挪出持久化层（第 5 步）──────────────────────────────────────────
#
# 原先 reference_store.list_visible 里写死一句 if ref.source == "mythos"，让一个读写 JSON
# 的类知道了三件它不该知道的事：这世上有个叫 mythos 的市场、那家按人分、别家不是。
# 加第三家按人分的市场时得回来改它——而**漏改不报错**，只是别人的 skill 出现在你的列表里。


def test_store_filters_by_what_it_is_told_not_by_hardcoded_source(tmp_path):
    """同一批数据，换一组 per_user_sources 就换一种过滤结果 —— 说明规则来自参数。"""
    s = SkillReferenceStore(tmp_path)
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1", "alice"), name="m-alice"))
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "cowork", "2", "bob"), name="c-bob"))

    # 只有 mythos 按人分：cowork 那条即使 owner 是别人也照常显示（它是公开市场）
    names = sorted(r.name for r in s.list_visible("zhang", {"mythos"}))
    assert names == ["c-bob"]

    # 改成两家都按人分：cowork 那条也被过滤掉
    names = sorted(r.name for r in s.list_visible("zhang", {"mythos", "cowork"}))
    assert names == []

    # 一家都不按人分：全都显示
    names = sorted(r.name for r in s.list_visible("zhang", set()))
    assert names == ["c-bob", "m-alice"]


def test_a_third_per_user_market_needs_no_change_here(tmp_path):
    """**这条是第 5 步的意义所在**：新市场只要被告知按人分，过滤自动生效。

    持久化层里没有任何一处写着市场的名字，所以这里不需要改代码就支持了 'newmarket'。
    """
    s = SkillReferenceStore(tmp_path)
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "newmarket", "9", "li"), name="别人的"))
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "newmarket", "8", "zhang"), name="我的"))

    names = sorted(r.name for r in s.list_visible("zhang", {"newmarket"}))
    assert names == ["我的"]


def test_owner_missing_is_not_hidden(tmp_path):
    """owner 为空的老数据不隐藏（迁移遗留）。

    真正取内容时仍用当前用户去下载，由那家按权限拦，不会泄露——所以这里放行是安全的，
    而隐藏反而会让老用户的 skill 凭空消失。
    """
    s = SkillReferenceStore(tmp_path)
    s.add_reference(SkillReference(identity=ReferenceIdentity(GENERAL_SCOPE, "mythos", "1"), name="老数据"))
    assert [r.name for r in s.list_visible("zhang", {"mythos"})] == ["老数据"]


def test_market_reports_per_user_sources_from_adapters():
    """市场层的这份名单来自各家 adapter 自己声明，不是写死的。"""
    from netlivecowork.providers.capability.skills.services.market import SkillMarketService
    from netlivecowork.providers.capability.skills.adapters.cowork import CoworkMarketAdapter
    from netlivecowork.providers.capability.skills.adapters.mythos import MythosMarketAdapter

    m = SkillMarketService(
        adapters=[CoworkMarketAdapter("http://c"), MythosMarketAdapter("http://m")],
        store=None,
    )
    assert m.per_user_sources() == {"mythos"}


# ── v3：复合引用身份（market_scope + source + remote_id + principal）──────────

def test_reference_identity_separates_market_scope_and_principal():
    """同一 source/remote_id 在通用市场、profile 专属市场、不同 W3 用户下是三条引用。"""
    a = ReferenceIdentity("general", "mythos", "1129", "alice")
    b = ReferenceIdentity("ipmaster", "mythos", "1129", "alice")
    c = ReferenceIdentity("general", "mythos", "1129", "bob")
    assert len({a.reference_id, b.reference_id, c.reference_id}) == 3
    assert a.reference_id == ReferenceIdentity("general", "mythos", "1129", "alice").reference_id


def test_v2_reference_migrates_without_changing_visibility(tmp_path):
    """v2 记录读进 v3 模型：general 作用域、owner→principal、labels→manual_labels，
    可见范围不变。"""
    (tmp_path / "skill_references.json").write_text(json.dumps({
        "version": 2,
        "references": {"mythos:9": {
            "source": "mythos", "remote_id": "9", "name": "M",
            "owner": "alice", "labels": ["ipmaster"],
        }},
    }), encoding="utf-8")
    ref = SkillReferenceStore(tmp_path).list_references()[0]
    assert ref.identity == ReferenceIdentity("general", "mythos", "9", "alice")
    assert ref.manual_labels == ("ipmaster",)
    assert ref.effective_labels == ("ipmaster",)


def test_effective_labels_union_and_wildcard_fallback():
    """有效归属 = manual ∪ preset；两边都空才回落通配。"""
    preset_only = SkillReference(
        identity=ReferenceIdentity("ipmaster", "mythos", "1"), name="p",
        preset_bindings=("ipmaster",),
    )
    assert preset_only.effective_labels == ("ipmaster",)
    both = SkillReference(
        identity=ReferenceIdentity("ipmaster", "mythos", "1"), name="b",
        manual_labels=("mbb",), preset_bindings=("ipmaster",),
    )
    assert both.effective_labels == ("ipmaster", "mbb")
    bare = SkillReference(identity=ReferenceIdentity("general", "cowork", "1"), name="x")
    assert bare.effective_labels == (ANY_LABEL,)


def test_owner_compat_maps_shared_principal_to_none():
    """v2 兼容读法：principal="*" 读成 owner=None（共享来源没有引用者）。"""
    shared = SkillReference(identity=ReferenceIdentity("general", "cowork", "1"), name="s")
    mine = SkillReference(identity=ReferenceIdentity("general", "mythos", "1", "alice"), name="m")
    assert shared.owner is None
    assert mine.owner == "alice"
    assert (shared.source, shared.remote_id, shared.market_scope) == ("cowork", "1", "general")


def test_v3_store_roundtrip_writes_one_file_with_ledgers(tmp_path):
    """引用、随包播种账本、预置账本同一份 JSON；reference_id 是 dict 键。"""
    store = SkillReferenceStore(tmp_path)
    ref = SkillReference(
        identity=ReferenceIdentity("ipmaster", "mythos", "1", "alice"),
        name="x", description="d", preset_bindings=("ipmaster",),
    )
    store.add_reference(ref)

    data = json.loads((tmp_path / "skill_references.json").read_text(encoding="utf-8"))
    assert data["version"] == 3
    assert list(data["references"]) == [ref.identity.reference_id]
    assert set(data["preset_ledger"]) == {"active_bindings", "opt_outs"}
    assert data["seeded_defaults"] == []

    got = store.get_by_id(ref.identity.reference_id)
    assert got is not None and got.preset_bindings == ("ipmaster",)
    assert store.get_by_id("ref:v3:deadbeef") is None


def test_mutate_keeps_previous_complete_state_when_callback_fails(tmp_path):
    """事务回调中途抛错 → 文件保持旧状态，不出现半提交。"""
    store = SkillReferenceStore(tmp_path)
    store.add_reference(
        SkillReference(identity=ReferenceIdentity("general", "cowork", "1"), name="a", description="d")
    )
    before = (tmp_path / "skill_references.json").read_text(encoding="utf-8")

    def boom(data: dict) -> None:
        data["references"]["ref:v3:zzz"] = {"source": "cowork"}
        raise OSError("disk full")

    with pytest.raises(OSError):
        store.mutate(boom)
    assert (tmp_path / "skill_references.json").read_text(encoding="utf-8") == before


def test_legacy_get_reference_raises_on_ambiguity(tmp_path):
    """旧式 (source, remote_id) 查找遇到作用域重复必须大声失败，不许悄悄挑一家。"""
    store = SkillReferenceStore(tmp_path)
    store.add_reference(
        SkillReference(identity=ReferenceIdentity("general", "mythos", "9"), name="g", description="d")
    )
    store.add_reference(
        SkillReference(identity=ReferenceIdentity("ipmaster", "mythos", "9"), name="s", description="d")
    )
    with pytest.raises(ValueError):
        store.get_reference("mythos", "9")
    assert store.is_referenced("mythos", "9") is True


def test_set_manual_labels_by_opaque_id(tmp_path):
    store = SkillReferenceStore(tmp_path)
    ref = SkillReference(
        identity=ReferenceIdentity("general", "cowork", "1"), name="a", manual_labels=("ipmaster",)
    )
    store.add_reference(ref)
    store.set_manual_labels(ref.identity.reference_id, ["mbb"])
    got = store.get_by_id(ref.identity.reference_id)
    assert got is not None and got.manual_labels == ("mbb",)
    store.remove_by_id(ref.identity.reference_id)
    assert store.list_references() == []
