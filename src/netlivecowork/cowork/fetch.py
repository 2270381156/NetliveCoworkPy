"""与云端管理服务通信 —— 问"我能用哪几个"、取包。

## 谁来用这段

**地端的主路径不在这里**：用户令牌只存在客户端主进程的安全存储里（需求 B2），
所以真实下发由主进程去取、摆进一个暂存目录，后端只负责装（需求 C3）。

本模块存在的理由有三个：

  1. **契约只写一处**：端点形状、错误分类、哈希校验的规则在这里定义并被测透，
     主进程那侧照着同一份规则实现；
  2. 开发与联调时可以直接用它对一次账，不必起 Electron；
  3. 将来若有"服务令牌"形态的部署（不需要用户身份），它可以直接用。

## 契约（运维给定，本产品只消费）

    GET <base>/api/me/agents               → [{"agentId": "ipmaster", "version": 3}]
    GET <base>/api/me/agents/<id>/package  → zip 原文 + 响应头 X-Package-Sha256

三条要点，每一条错了都不报错：

  * `version` 是**递增整数**，不是语义化版本号。管理员回滚时它会**变小** ——
    所以判"要不要装"一律用相等比较（在 entitlement.plan 里）；
  * 不存在的 agentId 返回 **400**，不是 404；
  * 云端**没法主动通知我们**权限变了，只能定期去问。
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "/api/me/agents"
DEFAULT_TIMEOUT = 30.0

#: 全部重试都失败才算这次对账失败（需求 B8）。一次抖动不该触发"一动不动"那条分支——
#: 那会让权限更新平白晚一天。
DEFAULT_RETRIES = 2
DEFAULT_BACKOFF = (2.0, 6.0)

#: 单包上限（需求 C14）。设这道闸是为了让"地址指错、指到个几 GB 的东西"当场失败，
#: 而不是把磁盘塞满之后才发现。
MAX_PACKAGE_BYTES = 10 * 1024 * 1024


class FetchError(Exception):
    """取不到。**调用方据此保持现状**，不要当成"这个人没有任何 cowork"。

    `kind` 用来分类呈现（需求 B9）：四种的下一步完全不同 ——
    重新登录 / 去申请 / 等管理员 / 删本地残留。合并成"无权限"会让用户去做完全错误的事。
    """

    def __init__(self, message: str, *, kind: str = "unknown", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


#: 错误分类。**这几个值会被界面用来决定说什么**，不要随手改。
KIND_UNAUTHENTICATED = "unauthenticated"   # 401 —— 令牌无效/过期，去重新登录
KIND_FORBIDDEN = "forbidden"               # 403 —— 没有这个授权，去申请
KIND_BAD_REQUEST = "bad_request"           # 400 —— 不认识这个 id，多半是本地残留
KIND_UNREACHABLE = "unreachable"           # 连不上/超时
KIND_MALFORMED = "malformed"               # 应答读不懂
KIND_UNKNOWN = "unknown"


@dataclass(frozen=True)
class AgentRef:
    agent_id: str
    version: int


@dataclass
class SyncResult:
    """一次对账的结果。**`ok=False` 时调用方必须一动不动**（需求 C7）。"""

    ok: bool
    entitled: list[str] = field(default_factory=list)
    downloaded: dict[str, bytes] = field(default_factory=dict)
    unchanged: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    reason: str = ""
    kind: str = ""


def _headers(token: str | None, accept: str) -> dict[str, str]:
    h = {"Accept": accept}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _classify(resp: httpx.Response) -> tuple[str, str]:
    """状态码 → (分类, 给人看的说法)。

    ⚠ **不存在的 id 返回 400 而不是 404**（契约如此）。按状态码分支的要注意。
    """
    code = resp.status_code
    if code == 401:
        return KIND_UNAUTHENTICATED, "令牌无效或已过期，需要重新登录"
    if code == 403:
        return KIND_FORBIDDEN, "被拒绝：没有这个授权"
    if code == 400:
        return KIND_BAD_REQUEST, "云端不认识这个 id（多半是本地残留了一个已删的）"
    return KIND_UNKNOWN, f"云端返回 {code}"


def _message_of(resp: httpx.Response) -> str:
    """云端的 message 是写给人看的整句，**原样带出去**（需求 B9）。"""
    try:
        body = resp.json()
        if isinstance(body, dict) and isinstance(body.get("message"), str):
            return body["message"]
    except Exception:
        pass
    return (resp.text or "")[:200]


def _get(
    url: str,
    token: str | None,
    accept: str,
    *,
    ssl_verify: bool | str,
    timeout: float,
    retries: int,
    backoff: tuple[float, ...],
    sleep=time.sleep,
) -> httpx.Response:
    """带重试的 GET。**只重试"可能是抖动"的失败**。

    4xx 不重试：令牌过期、没授权、id 不认识——再试几次结果一样，
    白白拖长启动并给云端添负担。
    """
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with httpx.Client(trust_env=False, timeout=timeout, verify=ssl_verify) as c:
                resp = c.get(url, headers=_headers(token, accept))
            if 400 <= resp.status_code < 500:
                kind, hint = _classify(resp)
                raise FetchError(f"{hint}：{_message_of(resp)}", kind=kind,
                                 status=resp.status_code)
            resp.raise_for_status()
            return resp
        except FetchError:
            raise                     # 4xx，不重试
        except Exception as e:
            last = e
            if attempt >= retries:
                break
            delay = backoff[min(attempt, len(backoff) - 1)] if backoff else 0
            # ⚠ 日志里不能出现令牌（需求 B2/NFR-8）。这里只记地址与原因。
            logger.warning("cowork：取 %s 失败（%s），%.1fs 后重试 %d/%d",
                           url, e, delay, attempt + 1, retries)
            if delay:
                sleep(delay)
    raise FetchError(f"连不上云端管理服务（{url}）：{last}", kind=KIND_UNREACHABLE) from last


def list_agents(
    base_url: str,
    token: str | None,
    *,
    ssl_verify: bool | str = False,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    backoff: tuple[float, ...] = DEFAULT_BACKOFF,
    sleep=time.sleep,
) -> list[AgentRef]:
    """这个人被授权了哪几个。任何失败都收敛成 `FetchError`。"""
    if not (base_url or "").strip():
        raise FetchError("云端管理服务地址未配置", kind=KIND_UNREACHABLE)
    url = f"{base_url.rstrip('/')}/{endpoint.strip('/')}"
    resp = _get(url, token, "application/json", ssl_verify=ssl_verify, timeout=timeout,
                retries=retries, backoff=backoff, sleep=sleep)
    try:
        body = resp.json()
    except Exception as e:
        raise FetchError(f"授权清单不是 JSON（{url}）", kind=KIND_MALFORMED) from e
    if not isinstance(body, list):
        raise FetchError(f"授权清单不是数组（{url}）", kind=KIND_MALFORMED)

    out: list[AgentRef] = []
    for item in body:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("agentId") or "").strip()
        raw = item.get("version")
        if not aid or not isinstance(raw, (int, float)) or isinstance(raw, bool):
            # 一条读不懂**不该让这个人一个 cowork 都没有** —— 那与"没授权"长得一模一样。
            logger.warning("cowork：授权清单里有一条读不懂，跳过：%r", item)
            continue
        out.append(AgentRef(agent_id=aid, version=int(raw)))
    return out


def download_package(
    base_url: str,
    token: str | None,
    agent_id: str,
    *,
    ssl_verify: bool | str = False,
    endpoint: str = DEFAULT_ENDPOINT,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    backoff: tuple[float, ...] = DEFAULT_BACKOFF,
    sleep=time.sleep,
) -> bytes:
    """取一个套件的 zip。

    **哈希从响应头取并当场校验**（需求 C8）：装一份"不知道是什么"的套件，
    比这次不更新危险得多。
    ⚠ 这一层防的是传输损坏与截断；**防篡改是签名的事** —— 哈希与包走同一条通道，
    能改包的人也能改哈希。
    """
    url = f"{base_url.rstrip('/')}/{endpoint.strip('/')}/{agent_id}/package"
    resp = _get(url, token, "application/octet-stream,application/zip,*/*",
                ssl_verify=ssl_verify, timeout=timeout, retries=retries,
                backoff=backoff, sleep=sleep)

    data = resp.content
    if len(data) > MAX_PACKAGE_BYTES:
        raise FetchError(
            f"套件超过 {MAX_PACKAGE_BYTES // 1024 // 1024} MB 上限（{len(data)} 字节），拒绝",
            kind=KIND_MALFORMED,
        )
    want = (resp.headers.get("X-Package-Sha256") or "").strip().lower()
    if want:
        got = hashlib.sha256(data).hexdigest()
        if got != want:
            raise FetchError(
                f"sha256 对不上：头里说 {want[:12]}…，实际 {got[:12]}…",
                kind=KIND_MALFORMED,
            )
    return data


def sync(
    base_url: str,
    token: str | None,
    installed: dict[str, str],
    *,
    ssl_verify: bool | str = False,
    endpoint: str = DEFAULT_ENDPOINT,
    **kw,
) -> SyncResult:
    """对一次账：拉清单 → 下载版本不同的。**不写盘**（写盘是调用方的事）。

    ⚠ **清单取不到就整个不动**（需求 C7）：`ok=False` 时不要动本地任何状态。
    网络抖一下把人家的套件全删了，比"今天没更新到"严重得多。

    `installed` 是本地已装的 id → 版本。相等就跳过下载，**但它仍然算在 entitled 里** ——
    否则装的那一侧会把它当成被收回而删掉（需求 C4 的反面）。
    """
    try:
        agents = list_agents(base_url, token, ssl_verify=ssl_verify, endpoint=endpoint, **kw)
    except FetchError as e:
        return SyncResult(ok=False, reason=str(e), kind=e.kind)

    downloaded: dict[str, bytes] = {}
    unchanged: list[str] = []
    failed: dict[str, str] = {}

    for ref in agents:
        # 相等比较，不是"变大才装"：回滚时 version 会变小，而回滚同样要装下去。
        if installed.get(ref.agent_id) == str(ref.version):
            unchanged.append(ref.agent_id)
            continue
        try:
            downloaded[ref.agent_id] = download_package(
                base_url, token, ref.agent_id, ssl_verify=ssl_verify, endpoint=endpoint, **kw
            )
        except FetchError as e:
            # 单个失败不拖垮整批，**也不算被收回**（需求 C9）：
            # 一次 403 不该等于替对方做了收回决定。
            logger.warning("cowork：套件下载失败 %s@%s：%s", ref.agent_id, ref.version, e)
            failed[ref.agent_id] = str(e)

    return SyncResult(
        ok=True,
        entitled=[r.agent_id for r in agents],   # ⚠ 含下载失败的，见上
        downloaded=downloaded,
        unchanged=unchanged,
        failed=failed,
    )
