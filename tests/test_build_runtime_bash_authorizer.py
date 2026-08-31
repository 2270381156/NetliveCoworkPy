"""build_host_runtime wires SelectiveBashAuthorizer onto fs:bash_exec and narrows the
fs blacklist to fatal-only."""
from __future__ import annotations

import types

from ctx_weft.protocols.filesystem import FsTool, FS_PROVIDER_NAME
from netlivecowork.providers.capability.fs_bash_compat import FS_BASH_EXEC
from netlivecowork.auth.bash_authorizer import SelectiveBashAuthorizer
from netlivecowork.auth.fs_write_authorizer import WorkspaceWriteAuthorizer
from netlivecowork.bootstrap import build_host_runtime
from netlivecowork.bootstrap.host_runtime import FATAL_ONLY_BLACKLIST


def test_authorizer_is_selective():
    args = types.SimpleNamespace(enable_tools=True, skills_dir="__none__")
    hr = build_host_runtime(args)
    authz = hr.core.providers.get_capability_authorizers()[FS_BASH_EXEC]
    assert isinstance(authz, SelectiveBashAuthorizer)


def test_write_and_edit_have_workspace_authorizer():
    args = types.SimpleNamespace(enable_tools=True, skills_dir="__none__")
    hr = build_host_runtime(args)
    authzs = hr.core.providers.get_capability_authorizers()
    assert isinstance(authzs[FsTool.WRITE_FILE], WorkspaceWriteAuthorizer)
    assert isinstance(authzs[f"{FS_PROVIDER_NAME}:edit_file"], WorkspaceWriteAuthorizer)


def test_fatal_blacklist_drops_rm_keeps_dd():
    assert "rm" not in FATAL_ONLY_BLACKLIST
    assert "dd" in FATAL_ONLY_BLACKLIST
