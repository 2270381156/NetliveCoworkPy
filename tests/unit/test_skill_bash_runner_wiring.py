"""装配根给 skill provider 接上路由到 fs.shell 的 bash_runner。"""

from ctx_weft.providers.capability_filesystem import (
    FilesystemConfig,
    FilesystemToolsProvider,
)
from ctx_weft.providers.capability_skill_local import LocalSkillCapabilityProvider


def test_bash_runner_routes_to_fs_invoke(monkeypatch):
    fs = FilesystemToolsProvider(FilesystemConfig())
    seen = {}

    def fake_invoke(cap_id, args, ctx):
        seen["cap_id"] = cap_id
        seen["args"] = args
        return iter(())  # 占位,不需真跑

    monkeypatch.setattr(fs, "invoke", fake_invoke)
    from netlivecowork.bootstrap.host_runtime import _bash_runner_for
    bash_runner = _bash_runner_for(fs)

    prov = LocalSkillCapabilityProvider("/tmp/skills", bash_runner=bash_runner)
    prov._bash_runner("echo hi", object())
    assert seen["cap_id"].endswith(":shell")
    assert seen["args"] == {"command": "echo hi"}
