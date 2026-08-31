import importlib
import os
from netlivecowork import config as cfgmod


def _fresh():
    importlib.reload(cfgmod)
    return cfgmod


def _clear(monkeypatch):
    for k in list(os.environ):
        if k.startswith("NLC_"):
            monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)


def test_defaults(monkeypatch):
    _clear(monkeypatch)
    s = _fresh().Settings.from_env()
    assert s.watch_interval == 5.0
    assert s.log_format == "text"
    assert s.snapshot_every_n == 50
    assert s.snapshot_keep == 3
    assert s.database_url == "sqlite"
    assert s.hitl_max_resolved == 1000
    assert s.task_max_concurrent == 1
    assert s.llm_max_http_retries == 3
    assert s.fs_glob_max_results == 500
    assert s.hitl_timeout_sec is None


def test_env_override(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("NLC_TASK_MAX_CONCURRENT", "16")
    monkeypatch.setenv("NLC_FS_GLOB_MAX_RESULTS", "9")
    s = _fresh().Settings.from_env()
    assert s.task_max_concurrent == 16
    assert s.fs_glob_max_results == 9


def test_default_template_id_default(monkeypatch):
    _clear(monkeypatch)
    s = _fresh().Settings.from_env()
    assert s.default_template_id == "default"


def test_default_template_id_env_override(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("NLC_DEFAULT_TEMPLATE_ID", "house")
    s = _fresh().Settings.from_env()
    assert s.default_template_id == "house"


def test_bad_int_falls_back(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("NLC_SNAPSHOT_KEEP", "notanint")
    s = _fresh().Settings.from_env()
    assert s.snapshot_keep == 3


def test_get_settings_singleton():
    m = _fresh()
    assert m.get_settings() is m.get_settings()


def test_to_runtime_config(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("NLC_TASK_MAX_RETRIES", "9")
    s = _fresh().Settings.from_env()
    rc = s.to_runtime_config()
    assert rc.task_max_retries == 9
    assert rc.default_token_budget == 200_000
    assert rc.hitl_timeout_sec is None


def test_skill_urls_default_none(monkeypatch):
    # 无默认值：未配置则为 None（软要求，主程序照常启动）。
    _clear(monkeypatch)
    s = _fresh().Settings.from_env()
    assert s.skill_pull_server_url is None
    assert s.skill_mythos_base_url is None


def test_skill_urls_override(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("NLC_SKILL_PULL_SERVER_URL", "http://example.com/api")
    monkeypatch.setenv("NLC_SKILL_MYTHOS_BASE_URL", "https://m.example.com")
    s = _fresh().Settings.from_env()
    assert s.skill_pull_server_url == "http://example.com/api"
    assert s.skill_mythos_base_url == "https://m.example.com"
