"""模板 id 以目录名为准。

现场：界面上有 `testcowork` 这个智能体（`/coworks` 按目录列的），点新建会话发第一条消息，
消息框下面一行红字

    agent:testcowork 不可用：未安装或你没有它的权限

用户明明有权限。真正的原因是这个套件的 SOUL.md 里写的 name 不是 testcowork——模板注册在了
那个名字下，按 cowork id 当然查不到。**这条错误把"套件打错了"说成了"你没权限"**，谁看了
都会去找管理员，而管理员那边一切正常。
"""
from pathlib import Path
from types import SimpleNamespace

from netlivecowork.providers.templates.syncer import _template_id_of


def test_id_comes_from_directory():
    d = Path("/data/coworks/mbb")
    assert _template_id_of(d, SimpleNamespace(id="mbb")) == "mbb"


def test_directory_wins_over_the_file():
    # cowork id 是这个系统里到处在用的身份（会话的 template_id、entitled 清单、skill 归属、
    # LLM allow 名单）；文件里那行 name 只是套件作者写的一句话。
    d = Path("/data/coworks/testcowork")
    assert _template_id_of(d, SimpleNamespace(id="ipmaster")) == "testcowork"


def test_mismatch_is_logged(caplog):
    """能用是对用户的，日志是给修包的人的——不喊出来，这个包就一直是错的。"""
    d = Path("/data/coworks/testcowork")
    with caplog.at_level("WARNING"):
        _template_id_of(d, SimpleNamespace(id="ipmaster"))
    assert "testcowork" in caplog.text and "ipmaster" in caplog.text


def test_missing_id_in_file_is_not_a_mismatch():
    d = Path("/data/coworks/mbb")
    assert _template_id_of(d, SimpleNamespace(id="")) == "mbb"
    assert _template_id_of(d, SimpleNamespace()) == "mbb"
