"""与云端管理服务的通信。

这一组测的是**契约怎么被消费**：端点形状、错误分类、哈希校验、重试边界。
地端真实取包在客户端主进程（令牌只在那儿），但规则只写一处 ——
主进程那侧照着同一份规则实现，这里把规则测透。

最要紧的一条贯穿全组：**取不到清单时，结果必须是"这次不算数"，
而不是"这个人没有任何 cowork"**。两者在数据上长得一样，处置完全相反。
"""
from __future__ import annotations

import hashlib

import httpx
import pytest

from netlivecowork.cowork import fetch

BASE = "https://cloud.test"


def _client(handler):
    """把 httpx 换成一个受控的传输层。"""
    return httpx.MockTransport(handler)


@pytest.fixture
def transport(monkeypatch):
    """让 fetch 里的 httpx.Client 走我们给的 handler。"""
    holder = {}

    class _Client(httpx.Client):
        def __init__(self, *a, **kw):
            kw.pop("verify", None)
            kw.pop("trust_env", None)
            super().__init__(*a, transport=_client(holder["handler"]), **kw)

    monkeypatch.setattr(fetch.httpx, "Client", _Client)

    def install(handler):
        holder["handler"] = handler
    return install


def _json(payload, status=200, headers=None):
    return lambda req: httpx.Response(status, json=payload, headers=headers or {})


# ── 授权清单 ──────────────────────────────────────────────────────────────────

def test_lists_agents(transport):
    transport(_json([{"agentId": "ipmaster", "version": 3}, {"agentId": "mbb", "version": 1}]))
    got = fetch.list_agents(BASE, "tok")
    assert [(a.agent_id, a.version) for a in got] == [("ipmaster", 3), ("mbb", 1)]


def test_one_unreadable_entry_does_not_empty_the_list(transport):
    """**一条读不懂不该让这个人一个 cowork 都没有** —— 那与"没授权"长得一模一样。"""
    transport(_json([
        {"agentId": "ok", "version": 1},
        {"agentId": "", "version": 2},          # 没 id
        {"agentId": "novers"},                  # 没版本
        {"agentId": "boolver", "version": True},  # bool 是 int 的子类，要挡
        "not-an-object",
    ]))
    assert [a.agent_id for a in fetch.list_agents(BASE, "tok")] == ["ok"]


def test_a_non_array_body_is_malformed(transport):
    transport(_json({"agents": []}))
    with pytest.raises(fetch.FetchError) as e:
        fetch.list_agents(BASE, "tok")
    assert e.value.kind == fetch.KIND_MALFORMED


def test_a_missing_base_url_fails_fast(transport):
    with pytest.raises(fetch.FetchError) as e:
        fetch.list_agents("", "tok")
    assert e.value.kind == fetch.KIND_UNREACHABLE


def test_the_token_goes_in_the_authorization_header(transport):
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json=[])

    transport(handler)
    fetch.list_agents(BASE, "secret-token")
    assert seen["auth"] == "Bearer secret-token"


def test_no_token_means_no_authorization_header(transport):
    seen = {}

    def handler(req):
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json=[])

    transport(handler)
    fetch.list_agents(BASE, None)
    assert seen["auth"] is None


# ── 错误分类 ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("status,kind", [
    (401, fetch.KIND_UNAUTHENTICATED),
    (403, fetch.KIND_FORBIDDEN),
    (400, fetch.KIND_BAD_REQUEST),
])
def test_status_codes_map_to_distinct_kinds(transport, status, kind):
    """**四种的下一步完全不同**（需求 B9）：重新登录 / 去申请 / 等管理员 / 删本地残留。

    合并成"无权限"会让用户去做完全错误的事。
    """
    transport(_json({"message": "云端说的原话"}, status=status))
    with pytest.raises(fetch.FetchError) as e:
        fetch.list_agents(BASE, "tok")
    assert e.value.kind == kind
    assert e.value.status == status


def test_the_cloud_message_is_passed_through_verbatim(transport):
    """云端的 message 是写给人看的整句，原样带出去 —— 我们再包装一层只会更含糊。"""
    transport(_json({"message": "该智能体已下线，请联系管理员"}, status=403))
    with pytest.raises(fetch.FetchError, match="该智能体已下线"):
        fetch.list_agents(BASE, "tok")


def test_a_nonexistent_id_is_400_not_404(transport):
    """⚠ 契约如此：不存在的 agentId 返回 **400**。按状态码分支的要注意。"""
    transport(_json({"message": "unknown agent"}, status=400))
    with pytest.raises(fetch.FetchError) as e:
        fetch.download_package(BASE, "tok", "ghost")
    assert e.value.kind == fetch.KIND_BAD_REQUEST


def test_connection_failure_is_unreachable(transport):
    def handler(req):
        raise httpx.ConnectError("no route", request=req)

    transport(handler)
    with pytest.raises(fetch.FetchError) as e:
        fetch.list_agents(BASE, "tok", retries=0)
    assert e.value.kind == fetch.KIND_UNREACHABLE


# ── 重试 ──────────────────────────────────────────────────────────────────────

def test_transient_failures_are_retried_then_succeed(transport):
    """一次抖动不该触发"一动不动"那条分支 —— 那会让权限更新平白晚一天。"""
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("flaky", request=req)
        return httpx.Response(200, json=[{"agentId": "a", "version": 1}])

    transport(handler)
    slept = []
    got = fetch.list_agents(BASE, "tok", retries=2, backoff=(2.0, 6.0), sleep=slept.append)
    assert [a.agent_id for a in got] == ["a"]
    assert slept == [2.0, 6.0], "退避间隔要逐次拉长"


def test_all_retries_exhausted_is_a_failure(transport):
    """**全部重试都失败才算这次对账失败**（需求 B8）。"""
    def handler(req):
        raise httpx.ConnectError("down", request=req)

    transport(handler)
    with pytest.raises(fetch.FetchError):
        fetch.list_agents(BASE, "tok", retries=2, backoff=(0, 0), sleep=lambda _: None)


def test_client_errors_are_not_retried(transport):
    """4xx 不重试：令牌过期、没授权、id 不认识 —— 再试几次结果一样，
    白白拖长启动并给云端添负担。
    """
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(401, json={"message": "expired"})

    transport(handler)
    with pytest.raises(fetch.FetchError):
        fetch.list_agents(BASE, "tok", retries=3, backoff=(0,), sleep=lambda _: None)
    assert calls["n"] == 1, "4xx 只该请求一次"


# ── 下载与校验 ────────────────────────────────────────────────────────────────

def _pkg_response(data: bytes, *, sha: str | None = None):
    headers = {}
    if sha is not None:
        headers["X-Package-Sha256"] = sha
    return lambda req: httpx.Response(200, content=data, headers=headers)


def test_downloads_the_package(transport):
    transport(_pkg_response(b"PK\x03\x04zip"))
    assert fetch.download_package(BASE, "tok", "a") == b"PK\x03\x04zip"


def test_the_hash_from_the_header_is_checked(transport):
    """**装一份"不知道是什么"的套件，比这次不更新危险得多**（需求 C8）。"""
    data = b"content"
    transport(_pkg_response(data, sha=hashlib.sha256(data).hexdigest()))
    assert fetch.download_package(BASE, "tok", "a") == data


def test_a_mismatched_hash_is_refused(transport):
    transport(_pkg_response(b"content", sha="0" * 64))
    with pytest.raises(fetch.FetchError, match="sha256"):
        fetch.download_package(BASE, "tok", "a")


def test_a_missing_hash_header_is_tolerated(transport):
    """头里没给就不校验 —— 但这一层本来也只防传输损坏，防篡改靠签名。"""
    transport(_pkg_response(b"content"))
    assert fetch.download_package(BASE, "tok", "a") == b"content"


def test_an_oversized_package_is_refused(transport):
    """让"地址指错、指到个几 GB 的东西"当场失败，而不是把磁盘塞满之后才发现。"""
    transport(_pkg_response(b"x" * (fetch.MAX_PACKAGE_BYTES + 1)))
    with pytest.raises(fetch.FetchError, match="上限"):
        fetch.download_package(BASE, "tok", "a")


# ── 一次完整对账 ──────────────────────────────────────────────────────────────

def test_sync_downloads_only_what_changed(transport):
    def handler(req):
        if req.url.path.endswith("/agents"):
            return httpx.Response(200, json=[
                {"agentId": "same", "version": 1},
                {"agentId": "changed", "version": 2},
            ])
        return httpx.Response(200, content=b"zipdata")

    transport(handler)
    r = fetch.sync(BASE, "tok", installed={"same": "1", "changed": "1"})

    assert r.ok
    assert r.unchanged == ["same"]
    assert list(r.downloaded) == ["changed"]


def test_sync_reports_unchanged_ones_as_still_entitled(transport):
    """**版本没变的仍然算在 entitled 里** —— 否则装的那一侧会把它当成被收回而删掉。

    这是"暂存目录里没有它的 zip ≠ 它被收回"的根源，也是为什么凭据不能靠数目录里的包。
    """
    def handler(req):
        if req.url.path.endswith("/agents"):
            return httpx.Response(200, json=[{"agentId": "same", "version": 1}])
        return httpx.Response(200, content=b"x")

    transport(handler)
    r = fetch.sync(BASE, "tok", installed={"same": "1"})
    assert r.entitled == ["same"] and r.downloaded == {}


def test_sync_failure_means_do_nothing(transport):
    """**这条是整组最要紧的。**

    拿不到清单时 `ok=False`，调用方必须一动不动。把网络故障当成权限被收回，
    后果是把用户的套件连同他改过的提示词删掉，**且不可逆**。
    """
    def handler(req):
        raise httpx.ConnectError("down", request=req)

    transport(handler)
    r = fetch.sync(BASE, "tok", installed={"a": "1"}, retries=0)

    assert r.ok is False
    assert r.entitled == [] and r.downloaded == {}
    assert r.kind == fetch.KIND_UNREACHABLE and r.reason


def test_one_download_failure_does_not_drop_it_from_entitled(transport):
    """**下载失败的不算被收回**（需求 C9）。

    一次 403 不该等于替对方做了收回决定 —— 它仍在授权里，只是这次没取到包。
    """
    def handler(req):
        if req.url.path.endswith("/agents"):
            return httpx.Response(200, json=[
                {"agentId": "ok", "version": 1},
                {"agentId": "broken", "version": 1},
            ])
        if "broken" in req.url.path:
            return httpx.Response(403, json={"message": "nope"})
        return httpx.Response(200, content=b"zip")

    transport(handler)
    r = fetch.sync(BASE, "tok", installed={})

    assert r.ok
    assert sorted(r.entitled) == ["broken", "ok"], "下载失败的仍在授权里"
    assert list(r.downloaded) == ["ok"]
    assert "broken" in r.failed


def test_sync_with_an_empty_entitlement_is_success_not_failure(transport):
    """**确实拿到了一张空清单** ≠ 没拿到。前者要删，后者不动。"""
    transport(_json([]))
    r = fetch.sync(BASE, "tok", installed={"a": "1"})
    assert r.ok is True and r.entitled == []


# ── 不许泄露令牌 ──────────────────────────────────────────────────────────────

def test_the_token_never_appears_in_error_messages(transport):
    """日志与报错都会被打包上传，**令牌绝不能出现在里面**（需求 B2/NFR-8）。"""
    def handler(req):
        raise httpx.ConnectError("boom", request=req)

    transport(handler)
    with pytest.raises(fetch.FetchError) as e:
        fetch.list_agents(BASE, "super-secret-token", retries=0)
    assert "super-secret-token" not in str(e.value)


def test_the_token_never_appears_in_logs(transport, caplog):
    def handler(req):
        raise httpx.ConnectError("boom", request=req)

    transport(handler)
    with caplog.at_level("WARNING"):
        with pytest.raises(fetch.FetchError):
            fetch.list_agents(BASE, "super-secret-token", retries=1,
                              backoff=(0,), sleep=lambda _: None)
    assert "super-secret-token" not in caplog.text
