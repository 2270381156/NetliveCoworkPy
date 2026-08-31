from netlivecowork.config import Settings


def test_runner_timeout_settings_have_defaults():
    s = Settings.from_env()
    assert s.fs_bash_idle_timeout_sec == 30
    assert s.fs_bash_hard_cap_sec == 3600
    assert s.skill_idle_timeout_sec == 90
    assert s.skill_hard_cap_sec == 600


def test_runner_settings_overridable_via_env(monkeypatch):
    monkeypatch.setenv("NLC_SKILL_IDLE_TIMEOUT_SEC", "45")
    s = Settings.from_env()
    assert s.skill_idle_timeout_sec == 45


def test_http_ssl_verify_defaults_false():
    assert Settings.from_env().http_ssl_verify is False


def test_http_ssl_verify_overridable_via_env(monkeypatch):
    monkeypatch.setenv("NLC_HTTP_SSL_VERIFY", "true")
    assert Settings.from_env().http_ssl_verify is True
