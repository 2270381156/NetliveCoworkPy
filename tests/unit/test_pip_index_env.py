"""可配置 pip 源:NLC_PIP_* 读入 Settings + 映射成标准 PIP_*。"""

import os

import netlivecowork.config as cfgmod
from netlivecowork.config import Settings


def test_settings_reads_pip_fields(monkeypatch):
    monkeypatch.setenv("NLC_PIP_INDEX_URL", "http://mirror/simple")
    monkeypatch.setenv("NLC_PIP_EXTRA_INDEX_URL", "http://extra/simple")
    monkeypatch.setenv("NLC_PIP_TRUSTED_HOST", "mirror")
    monkeypatch.setenv("NLC_PIP_TIMEOUT", "120")
    s = Settings.from_env()
    assert s.pip_index_url == "http://mirror/simple"
    assert s.pip_extra_index_url == "http://extra/simple"
    assert s.pip_trusted_host == "mirror"
    assert s.pip_timeout == "120"


def test_settings_pip_fields_default_none(monkeypatch):
    for k in ("NLC_PIP_INDEX_URL", "NLC_PIP_EXTRA_INDEX_URL", "NLC_PIP_TRUSTED_HOST", "NLC_PIP_TIMEOUT"):
        monkeypatch.delenv(k, raising=False)
    s = Settings.from_env()
    assert s.pip_index_url is None
    assert s.pip_extra_index_url is None
    assert s.pip_trusted_host is None
    assert s.pip_timeout is None


def test_apply_pip_index_env_maps_to_pip(monkeypatch):
    monkeypatch.setattr(os, "environ", dict(os.environ))
    for k in ("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST"):
        os.environ.pop(k, None)
    os.environ["NLC_PIP_INDEX_URL"] = "http://mirror/simple"
    os.environ["NLC_PIP_TRUSTED_HOST"] = "mirror"
    os.environ["NLC_PIP_TIMEOUT"] = "120"
    monkeypatch.setattr(cfgmod, "_settings", None)
    cfg = cfgmod.get_settings()
    cfgmod.apply_pip_index_env(cfg)
    assert os.environ["PIP_INDEX_URL"] == "http://mirror/simple"
    assert os.environ["PIP_TRUSTED_HOST"] == "mirror"
    assert os.environ["PIP_TIMEOUT"] == "120"


def test_apply_pip_index_env_noop_when_unset(monkeypatch):
    monkeypatch.setattr(os, "environ", dict(os.environ))
    for k in ("NLC_PIP_INDEX_URL", "NLC_PIP_EXTRA_INDEX_URL", "NLC_PIP_TRUSTED_HOST", "PIP_INDEX_URL"):
        os.environ.pop(k, None)
    monkeypatch.setattr(cfgmod, "_settings", None)
    cfg = cfgmod.get_settings()
    cfgmod.apply_pip_index_env(cfg)
    assert "PIP_INDEX_URL" not in os.environ
