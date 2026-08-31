"""DirAgentCapabilityProvider：store 元数据 + core loader 加载 + 默认 facet 合并。"""

from __future__ import annotations

from ctx_weft.providers.agent_template_local import TemplateLoader
from netlivecowork.providers.templates.provider import DirAgentCapabilityProvider


class _FakeStore:
    def __init__(self, mapping):
        self._m = mapping  # id -> Path

    async def get(self, tid):
        d = self._m.get(tid)
        return {"template_dir": str(d)} if d else None

    async def find_by_name(self, name):
        return await self.get(name)

    async def list_all(self):
        return [{"id": k, "name": k, "version": "1.0.0", "description": None}
                for k in self._m]


def _make_dir(tmp_path, name, *, compact=None, metadata=None):
    d = tmp_path / name
    d.mkdir()
    (d / "SOUL.md").write_text(
        f"---\nname: {name}\nversion: 1.0.0\n---\n{name} soul", encoding="utf-8"
    )
    if compact is not None:
        (d / "COMPACT.md").write_text(compact, encoding="utf-8")
    if metadata is not None:
        (d / "METADATA.md").write_text(metadata, encoding="utf-8")
    return d


async def test_get_template_inherits_default_facets(tmp_path):
    ddir = _make_dir(tmp_path, "default", compact="DEF-COMPACT", metadata="DEF-MD")
    fdir = _make_dir(tmp_path, "foo")
    prov = DirAgentCapabilityProvider(_FakeStore({"default": ddir, "foo": fdir}),
                                      TemplateLoader(), default_template_id="default")
    t = await prov.get_template("foo", None, None)
    assert t.identity["compact"].text == "DEF-COMPACT"
    assert t.identity["recognize_intent"].text == "DEF-MD"


async def test_get_template_miss_returns_none(tmp_path):
    prov = DirAgentCapabilityProvider(_FakeStore({}), TemplateLoader())
    assert await prov.get_template("nope", None, None) is None


async def test_default_itself_not_self_merged(tmp_path):
    ddir = _make_dir(tmp_path, "default", compact="DEF-COMPACT")
    prov = DirAgentCapabilityProvider(_FakeStore({"default": ddir}),
                                      TemplateLoader(), default_template_id="default")
    t = await prov.get_template("default", None, None)
    assert t.identity["compact"].text == "DEF-COMPACT"


async def test_workspace_injected_into_act_soul(tmp_path):
    from ctx_weft.protocols.context import ProviderContext
    fdir = _make_dir(tmp_path, "foo")
    prov = DirAgentCapabilityProvider(_FakeStore({"foo": fdir}), TemplateLoader())
    prov.set_workspace_lookup(lambda sid: "/work/ws" if sid == "s1" else None)
    t = await prov.get_template("foo", None, ProviderContext(session_id="s1"))
    assert "foo soul" in t.identity["act"].text        # 原 SOUL 正文保留
    assert "/work/ws" in t.identity["act"].text         # 工作区路径已注入
    assert "工作目录" in t.identity["act"].text


async def test_workspace_not_injected_when_unregistered(tmp_path):
    from ctx_weft.protocols.context import ProviderContext
    fdir = _make_dir(tmp_path, "foo")
    prov = DirAgentCapabilityProvider(_FakeStore({"foo": fdir}), TemplateLoader())
    prov.set_workspace_lookup(lambda sid: None)          # 未登记工作区
    t = await prov.get_template("foo", None, ProviderContext(session_id="s1"))
    assert t.identity["act"].text == "foo soul"          # 原样，不注入


async def test_workspace_end_to_end_with_real_fs_provider(tmp_path):
    """端到端（非假 lookup）：用真实 fs provider 的 workspace_for 做 lookup，证明"注册什么路径就注入
    什么路径"、且别的会话查不到 → 不注入（不串味、不发错路径给模型）。"""
    from ctx_weft.providers.capability_filesystem import FilesystemConfig
    from ctx_weft.protocols.context import ProviderContext
    from netlivecowork.providers.capability.fs_bash_compat import BashExecAliasFilesystemProvider

    ws = tmp_path / "realproj"
    ws.mkdir()
    fs = BashExecAliasFilesystemProvider(FilesystemConfig())
    fs.register_session("sess-42", str(ws))
    # cli.py 里就是这个闭包（包 fs.workspace_for），这里如实复刻，不用假 lambda。
    lookup = lambda sid: fs.workspace_for(ProviderContext(session_id=sid))

    fdir = _make_dir(tmp_path, "foo")
    prov = DirAgentCapabilityProvider(_FakeStore({"foo": fdir}), TemplateLoader())
    prov.set_workspace_lookup(lookup)

    t = await prov.get_template("foo", None, ProviderContext(session_id="sess-42"))
    assert str(ws) in t.identity["act"].text            # 注入的正是注册的真实路径
    t_other = await prov.get_template("foo", None, ProviderContext(session_id="ghost"))
    assert "工作目录" not in t_other.identity["act"].text  # 未注册会话 → 绝不注入错路径


async def test_workspace_no_lookup_and_no_ctx_are_safe(tmp_path):
    # 无 lookup（默认）+ ctx=None：不崩、不注入（现有调用方就这么用）。
    fdir = _make_dir(tmp_path, "foo")
    prov = DirAgentCapabilityProvider(_FakeStore({"foo": fdir}), TemplateLoader())
    t = await prov.get_template("foo", None, None)
    assert t.identity["act"].text == "foo soul"


async def test_list_null_description_coalesced(tmp_path):
    # 回归（原 test_list_summaries_null_description_coalesced）：DB 描述列可空 →
    # None 必须归一 ""，否则经装配层 content_to_text 崩溃。
    ddir = _make_dir(tmp_path, "a")
    prov = DirAgentCapabilityProvider(_FakeStore({"a": ddir}), TemplateLoader())
    caps = await prov.list(None)
    assert caps[0].id == "agent:a"
    assert caps[0].description == ""
