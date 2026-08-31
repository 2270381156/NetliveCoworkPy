"""ctx_weft seam: check_command_safety accepts an injectable blacklist.
Default arg keeps upstream behavior; a narrowed set lets rm/curl through."""
from __future__ import annotations

from ctx_weft.providers.capability_filesystem._bash_safety import (
    BASH_BLACKLIST,
    check_command_safety,
)

FATAL = frozenset({"format", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff"})


def test_default_blacklist_still_blocks_rm():
    assert check_command_safety("rm -rf build") is not None


def test_narrowed_blacklist_allows_rm():
    assert check_command_safety("rm -rf build", blacklist=FATAL) is None


def test_narrowed_blacklist_still_blocks_dd():
    assert check_command_safety("dd if=/dev/zero of=/dev/sda", blacklist=FATAL) is not None


def test_command_substitution_still_blocked_regardless_of_blacklist():
    assert check_command_safety("echo $(whoami)", blacklist=FATAL) is not None


def test_default_arg_unchanged():
    # Calling with no blacklist arg behaves exactly as before.
    assert check_command_safety("ls -la") is None
    assert check_command_safety("curl http://x") is not None
    assert "curl" in BASH_BLACKLIST
