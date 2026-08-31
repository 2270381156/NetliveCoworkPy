"""drawing_engine_dir() / drawing_engine_node_executable()：dev 态默认 + env override。"""
from __future__ import annotations

from pathlib import Path

from netlivecowork import paths
from netlivecowork.config import Settings, get_settings


def _reset_settings_cache(monkeypatch):
    # get_settings() 懒加载单例，测试里改 env 后必须让它重新读取。
    import netlivecowork.config as config_mod
    monkeypatch.setattr(config_mod, "_settings", None)


def test_drawing_engine_dir_defaults_to_repo_root_sibling(monkeypatch):
    _reset_settings_cache(monkeypatch)
    d = paths.drawing_engine_dir()
    assert d.name == "drawing-engine"
    assert d.parent == Path(__file__).resolve().parents[1]


def test_drawing_engine_dir_overridable_via_env(monkeypatch, tmp_path):
    _reset_settings_cache(monkeypatch)
    monkeypatch.setenv("NLC_DRAWING_ENGINE_DIR", str(tmp_path))
    assert paths.drawing_engine_dir() == tmp_path


def test_drawing_engine_node_executable_defaults_to_node_on_path(monkeypatch):
    _reset_settings_cache(monkeypatch)
    assert paths.drawing_engine_node_executable() == "node"


def test_drawing_engine_node_executable_overridable_via_env(monkeypatch):
    _reset_settings_cache(monkeypatch)
    monkeypatch.setenv("NLC_DRAWING_ENGINE_NODE_EXECUTABLE", r"C:\app\node-runtime\node.exe")
    assert paths.drawing_engine_node_executable() == r"C:\app\node-runtime\node.exe"


def test_settings_from_env_has_topology_fields():
    s = Settings.from_env()
    assert s.drawing_engine_dir is None
    assert s.drawing_engine_node_executable is None
