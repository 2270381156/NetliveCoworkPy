"""Host venv-creator-python 解析：env 读取 + 冻结态内置 runtime 探测。"""

import os
import sys

import pytest

from netlivecowork.bootstrap import frozen as _run

from netlivecowork.config import Settings


def test_settings_reads_bash_venv_python(monkeypatch):
    monkeypatch.setenv("NLC_FS_BASH_VENV_PYTHON", r"C:\app\python-runtime\python.exe")
    s = Settings.from_env()
    assert s.fs_bash_venv_python == r"C:\app\python-runtime\python.exe"


def test_settings_bash_venv_python_default_none(monkeypatch):
    monkeypatch.delenv("NLC_FS_BASH_VENV_PYTHON", raising=False)
    s = Settings.from_env()
    assert s.fs_bash_venv_python is None


def test_bundled_venv_python_found(tmp_path):
    rt = tmp_path / "python-runtime"
    rt.mkdir()
    exe = rt / "python.exe"
    exe.write_text("#!fake")
    assert _run._bundled_venv_python(str(tmp_path)) == str(exe)


def test_bundled_venv_python_absent(tmp_path):
    assert _run._bundled_venv_python(str(tmp_path)) is None


def _make_venv(tmp_path, *, base_dir, base_exists, key="executable"):
    """造一个最小 venv 目录：Scripts\\python.exe（重定向器占位）+ pyvenv.cfg 指向 base。
    base_exists=False 时不真的建出 base 的 python.exe，模拟改名/换目录后基础解释器悬空。"""
    venv = tmp_path / "venv"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "Scripts" / "python.exe").write_text("#!redirector")
    base = tmp_path / base_dir
    base.mkdir()
    base_py = base / "python.exe"
    if base_exists:
        base_py.write_text("#!fake-base")
    line = f"{key} = {base_py}" if key == "executable" else f"{key} = {base}"
    (venv / "pyvenv.cfg").write_text(
        f"home = {base}\ninclude-system-site-packages = false\nversion = 3.13.12\n"
        f"{line}\n"
    )
    return venv


def test_venv_base_present_when_base_exists(tmp_path):
    venv = _make_venv(tmp_path, base_dir="python-runtime", base_exists=True)
    assert _run._venv_base_present(str(venv)) is True


def test_venv_base_absent_when_base_missing(tmp_path):
    # 悬空 venv：pyvenv.cfg 里 base 指向的 python.exe 不存在（旧安装目录已改名/删除）。
    venv = _make_venv(tmp_path, base_dir="python-runtime", base_exists=False)
    assert _run._venv_base_present(str(venv)) is False


def test_venv_base_absent_when_no_cfg(tmp_path):
    venv = tmp_path / "venv"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "Scripts" / "python.exe").write_text("#!redirector")
    assert _run._venv_base_present(str(venv)) is False


def test_venv_base_falls_back_to_home_key(tmp_path):
    # 老 venv 只有 home、没有 executable：退回 home 目录 + python.exe 判断。
    venv = _make_venv(tmp_path, base_dir="python-runtime", base_exists=True, key="home")
    assert _run._venv_base_present(str(venv)) is True


def _fake_frozen(monkeypatch, tmp_path):
    """把 bootstrap.frozen 装成「冻结态」：sys.frozen/_MEIPASS/executable 指到 tmp_path，
    并用一份 os.environ 副本隔离 prepare() 对 os.environ 的写入（避免泄漏到其它测试）。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "app.exe"), raising=False)
    monkeypatch.setattr(os, "environ", dict(os.environ))
    (tmp_path / "python-runtime").mkdir()
    (tmp_path / "python-runtime" / "python.exe").write_text("#!fake")


# 注：prepare() 现在（「全应用共享 venv」重构后）除了解析 NLC_FS_BASH_VENV_PYTHON，还会调
# _ensure_shared_venv 真去建 venv、失败即硬退出。下面两个只验「env 解析」，故把建 venv 那步 stub 掉
# （建 venv 的行为不在这两个用例的关注点内）。

def test_bootstrap_sets_bundled_when_unset(monkeypatch, tmp_path):
    _fake_frozen(monkeypatch, tmp_path)
    os.environ.pop("NLC_FS_BASH_VENV_PYTHON", None)
    monkeypatch.setattr(_run, "_ensure_shared_venv", lambda *_a, **_k: None)
    _run.prepare()
    assert os.environ["NLC_FS_BASH_VENV_PYTHON"] == str(
        tmp_path / "python-runtime" / "python.exe"
    )


def test_bootstrap_does_not_overwrite_explicit_venv_python(monkeypatch, tmp_path):
    _fake_frozen(monkeypatch, tmp_path)
    # 显式值须是真实文件（新逻辑 line 91 要求 isfile，否则判缺失→硬退出）。
    custom = tmp_path / "custom" / "python.exe"
    custom.parent.mkdir()
    custom.write_text("#!fake")
    os.environ["NLC_FS_BASH_VENV_PYTHON"] = str(custom)
    monkeypatch.setattr(_run, "_ensure_shared_venv", lambda *_a, **_k: None)
    _run.prepare()
    assert os.environ["NLC_FS_BASH_VENV_PYTHON"] == str(custom)


def test_bootstrap_exits_when_bundled_missing(monkeypatch, tmp_path, capsys):
    # 冻结态但没有内置 runtime：打包只允许随包 python → FATAL + 硬退出（不静默回退，行为已从 warn 改为 exit）。
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "app.exe"), raising=False)
    monkeypatch.setattr(os, "environ", dict(os.environ))
    os.environ.pop("NLC_FS_BASH_VENV_PYTHON", None)
    with pytest.raises(SystemExit):
        _run.prepare()
    assert "python-runtime not found" in capsys.readouterr().out
    assert "NLC_FS_BASH_VENV_PYTHON" not in os.environ


def test_cli_filesystem_config_passes_venv_python_to_provider(monkeypatch):
    """env → Settings.fs_bash_venv_python → FilesystemConfig(bash_venv_python=...) →
    provider._cfg。镜像 bootstrap.host_runtime 构造 FilesystemConfig 的那行（build_host_runtime
    本身太重——会拉模板/建 runtime——不宜单测，故直接验证这条数据链）。"""
    monkeypatch.setenv("NLC_FS_BASH_VENV_PYTHON", r"C:\app\python-runtime\python.exe")
    import netlivecowork.config as cfgmod
    monkeypatch.setattr(cfgmod, "_settings", None)  # 重建单例以读到 env；monkeypatch 自动还原
    cfg = cfgmod.get_settings()

    from ctx_weft.providers.capability_filesystem import (
        FilesystemConfig,
        FilesystemToolsProvider,
    )
    provider = FilesystemToolsProvider(FilesystemConfig(
        bash_venv_python=cfg.fs_bash_venv_python,
    ))
    assert provider._cfg.bash_venv_python == r"C:\app\python-runtime\python.exe"


def test_skill_provider_wired_with_bundled_python(monkeypatch, tmp_path):
    """同一份内置 Python 也喂给 skill provider（镜像 cli.py 的构造表达式）。"""
    monkeypatch.setenv("NLC_FS_BASH_VENV_PYTHON", r"C:\app\python-runtime\python.exe")
    import netlivecowork.config as cfgmod
    monkeypatch.setattr(cfgmod, "_settings", None)
    cfg = cfgmod.get_settings()

    from ctx_weft.providers.capability_skill_local import LocalSkillCapabilityProvider
    prov = LocalSkillCapabilityProvider(tmp_path, python_executable=cfg.fs_bash_venv_python)
    assert prov._python_executable == r"C:\app\python-runtime\python.exe"
