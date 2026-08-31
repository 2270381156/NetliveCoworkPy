"""cowork 市场的接口方言。

跟 mythos 相比这家简单得多：目录一次返回全量（没有分页），不需要鉴权。

**它是唯一支持上传的**——用户可以把本地 skill 传回市场。所以 ``import_to_remote`` 在这里
覆盖，而基类的默认实现是抛 UNSUPPORTED：让"不支持"成为契约里的一等公民，好过让调用方
去猜哪家能传。

可见性用基类默认的 ``everyone``：cowork 上的 skill 对所有人一样。
"""

from __future__ import annotations

import httpx

from ..errors import SkillError
from .base import MarketContext, MarketItem, SkillMarketAdapter

_TIMEOUT = 30
_HEADERS = {"Accept": "application/json"}

SOURCE = "cowork"


def _err_message(resp: httpx.Response) -> str:
    """从 cowork 错误响应里取人类可读消息：优先 RFC7807 的 detail，其次 message/title，
    最后回退原始文本（截断）。避免把整个 JSON（about:blank/status/instance…）抛给用户。"""
    try:
        body = resp.json()
        if isinstance(body, dict):
            for k in ("detail", "message", "title"):
                v = body.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    except Exception:
        pass
    return (resp.text or "")[:500]


class CoworkMarketAdapter(SkillMarketAdapter):
    name = SOURCE

    def __init__(self, server_url: str, *, ssl_verify: bool | str = False) -> None:
        self._server_url = (server_url or "").rstrip("/")
        # 默认不校验 SSL（与 http_ssl_verify、LLM adapter 一致），以便指向 HTTPS
        # 内网/自签端点时也能直连；传 True 或 CA 路径可开启。
        self._ssl_verify = ssl_verify

    # ── 契约 ──────────────────────────────────────────────────────────────────

    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        """全量目录，一次取回。

        ``ctx`` 在这里用不到（cowork 不需要用户名）——**这是本适配器的事，不是调用方的事**。
        统一签名正是为了让上层不必先判断"这家要不要用户名"。
        """
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT, verify=self._ssl_verify) as client:
                resp = client.get(f"{url}/skills", headers=_HEADERS)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{_err_message(e.response)}")
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")

        return [_to_item(item) for item in resp.json()]

    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT, verify=self._ssl_verify) as client:
                resp = client.get(
                    f"{url}/skills/{remote_id}/export",
                    headers={**_HEADERS, "Accept": "application/zip,application/octet-stream,*/*"},
                )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise SkillError("REMOTE_SKILL_NOT_FOUND", f"远端 skill '{remote_id}' 不存在")
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{_err_message(e.response)}")
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")
        return resp.content

    def import_to_remote(self, data: bytes, filename: str, ctx: MarketContext) -> dict:
        """把本地 skill zip 传回 cowork 市场（**只有这家支持**）。

        ``ctx.auth_header``（形如 "Bearer <token>"）原样透传给 cowork：它的 JwtAuthFilter
        据此识别用户，把 skill 的 creator 写成该用户。不传则匿名上传（creator 为空）。
        """
        url = self._require_url()
        headers = dict(_HEADERS)
        if ctx.auth_header:
            headers["Authorization"] = ctx.auth_header
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT, verify=self._ssl_verify) as client:
                resp = client.post(
                    f"{url}/skills/import",
                    headers=headers,
                    files={"file": (filename, data, "application/zip")},
                )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            msg = _err_message(e.response)
            # cowork 对"市场已有同名 skill"返回 400。给一个稳定 code，让前端做本地化友好
            # 提示（cowork 原文是中文，直接显示对英文用户不友好）。
            if e.response.status_code == 400 and ("已存在" in msg or "exist" in msg.lower()):
                raise SkillError("SKILL_NAME_EXISTS", msg)
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{msg}")
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")

        item = resp.json()
        return {"skill_id": item.get("id", ""), "name": item.get("name", "")}

    # visibility 不覆盖：cowork 的 skill 人人可见，用基类默认。

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _require_url(self) -> str:
        # 错误码与文案照搬原实现，一个字都别改：前端按 code 分支，改了等于悄悄换 API。
        if not self._server_url:
            raise SkillError("PULL_SERVER_NOT_CONFIGURED", "远端 Skill 服务器 URL 未配置")
        return self._server_url


def _to_item(item: dict) -> MarketItem:
    """cowork 的字段名与归一后的形状几乎一致，只有 createTime 要改名。"""
    return MarketItem(
        id=str(item["id"]),
        name=item["name"],
        description=item.get("description"),
        updater=item.get("updater"),
        create_time=item.get("createTime"),
    )
