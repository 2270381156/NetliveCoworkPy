"""套件自带的 MCP（清单 `mcp.define`）要真的被注册。

这个字段一度只是**解析了没人用**：套件里 use + define 都写着，agent 却说自己没有这个
工具，而清单看上去完全正常。真正提供 server 的是应用随包那份 mcp.json —— 于是随包
一旦不发了（或被"下架清理"删掉），所有 cowork 一起失去它。实测踩过。
"""
from __future__ import annotations

from netlivecowork.cowork.manifest_parse import parse
from netlivecowork.providers.capability.mcp.store import _entry_to_config

#: 用户机器上那个 NFV 套件的真实形状（cowork.json 的 mcp 段）。
REAL = {
    "schema": 1, "id": "coremaster", "version": "1.0.0", "order": 20,
    "branding": {"displayName": "NFV Cowork"},
    "mcp": {
        "use": ["knowledge-a-net"],
        "define": {
            "knowledge-a-net": {
                "url": "http://knowledge-a-net.his-beta.huawei.com/mcp",
                "headers": {},
                "default_purposes": ["act"],
                "capability_purpose_override": {},
                "timeout_per_call_sec": 60,
                "connect_timeout_sec": 10,
            }
        },
    },
}


def test_the_manifest_carries_the_definition():
    c = parse(REAL)
    assert [d.name for d in c.mcp_define] == ["knowledge-a-net"]
    assert c.mcp_use == ("knowledge-a-net",)


def test_the_definition_converts_to_a_usable_config():
    """**必须复用 store 的转换器。**

    套件里 define 的那份就是 mcp.json 条目的原样形状，而"有 url 就是 http"这条推断
    只写在那个转换器里。自己拼 MCPServerConfig 的话 transport 会落到默认的 stdio，
    带着 url 走 stdio —— 连不上，而报错完全指不到套件这边。
    """
    d = parse(REAL).mcp_define[0]
    cfg = _entry_to_config(d.name, dict(d.config))
    assert cfg is not None
    assert cfg.transport == "http", "带 url 却推断成了 stdio —— 这条会静默连不上"
    assert cfg.url.endswith("/mcp")
    assert cfg.timeout_per_call_sec == 60


def test_a_broken_definition_is_skipped_not_fatal():
    """一个套件的定义写坏了，不该连累别的套件和整个启动。"""
    bad = {**REAL, "mcp": {"use": [], "define": {"x": {"no_url_no_command": 1}}}}
    d = parse(bad).mcp_define[0]
    assert _entry_to_config(d.name, dict(d.config)) is None
