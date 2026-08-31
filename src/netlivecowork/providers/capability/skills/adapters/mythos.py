"""mythos（IPmasterMythos）市场的接口方言。

跟 cowork 的差别全在这个文件里，上层一概不必知道：

    鉴权    每个请求带 ``x-cse-context`` 头（租户固定 2000 + 当前登录用户名）。
            用户名不对时查询接口会失败——调用方应当降级成只显示另一家，而不是整个报错。
    翻页    服务端分页（start/limit + total）。本文件内部翻完再拼成一整份返回。
    过滤    返回的列表里混着大量测试数据，只保留带 baseline tag 的。
    形状    字段名与 cowork 完全不同（skill_id / display_name / updated_time…），
            且 display_name 与 description 是 {default, zh_CN, en_US} 结构。

接口路径 / 参数 / 响应形状见 docs/skill市场新数据源接口.md。

**可见性是 per_user**：同一个 mythos 上，不同的人能看见的 skill 不一样。这个事实以前写在
``references.store.list_visible`` 里（一句 ``if ref.source == "mythos"``），现在由本文件
自己声明——加第三家市场时不必再回持久化层改代码。
"""

from __future__ import annotations

import io
import json
import logging
import time
import zipfile

import httpx

from ..errors import SkillError
from .base import (
    VISIBILITY_PER_USER,
    MarketContext,
    MarketItem,
    SkillMarketAdapter,
)

logger = logging.getLogger(__name__)

_TIMEOUT = 30
_QUERY_PATH = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/query"
_DOWNLOAD_PATH = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/download"

_PAGE_SIZE = 100          # 分批拉取的每页条数
_MAX_PAGES = 100          # 兜底：防止 total 异常导致死循环（最多 100*100=1万条）
_TENANT_ID = "2000"       # 租户 id 固定 2000
# query 返回的列表里混了很多测试数据：只保留 tag_names 含此 tag 的 skill
# （可以同时带其它 tag，不影响）。
_BASELINE_TAG = "IPmaster_Baseline"

#: 目录缓存有效期。市场页刷得勤，而这家翻页要打好几个来回。
_CACHE_TTL_SEC = 30.0

SOURCE = "mythos"


class MythosMarketAdapter(SkillMarketAdapter):
    name = SOURCE
    #: 同一个 mythos 上不同的人看见的 skill 不同 —— 引用要记 owner，列表要按人过滤。
    visibility = VISIBILITY_PER_USER

    def __init__(
        self,
        base_url: str,
        *,
        ssl_verify: bool | str = False,
        cache_ttl_sec: float = _CACHE_TTL_SEC,
    ) -> None:
        self._base_url = (base_url or "").rstrip("/")
        # 真实 mythos 是 HTTPS 内网服务（多为内部 CA / 自签证书）。默认不校验证书
        # （与 http_ssl_verify、LLM adapter 的默认一致）；传 True 或 CA 路径可开启。
        self._ssl_verify = ssl_verify
        # 短期缓存。**这是 mythos 独有的需要**：它翻页要打好几个来回，而市场页会被反复
        # 刷新。cowork 一次就取回全量，不需要。缓存原先放在市场层，那等于让上层知道
        # "这家慢、那家快"——而快慢正是接口方言的一部分。
        # 按用户名分桶：mythos 的目录因人而异，共用一份会串号。
        self._cache_ttl_sec = max(0.0, cache_ttl_sec)
        self._cache: dict[str, tuple[float, list[MarketItem]]] = {}

    # ── 契约 ──────────────────────────────────────────────────────────────────

    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        """翻完所有页，返回**一整份**已归一的目录。

        上层不知道这里翻了几页——这正是契约要的：``list_catalog`` 的调用方永远只面对
        一个完整列表，不为"这家是分页的"写任何分支。

        带**短期缓存**（按用户名分桶）：翻页要打好几个来回，而市场页会被反复刷新。
        缓存是这家的实现细节，上层不该知道谁快谁慢。

        任何失败都抛 SkillError（用户名不对、连不上、5xx），由市场层决定是整体失败还是
        只降级掉这一家。
        """
        username = self._require_username(ctx)
        url = self._require_url()

        cached = self._cache.get(username)
        if cached and (time.monotonic() - cached[0]) < self._cache_ttl_sec:
            return list(cached[1])          # 拷一份：调用方排序/加工不该污染缓存

        items = self._fetch_all_pages(url, username)
        self._cache[username] = (time.monotonic(), list(items))
        return items

    def _fetch_all_pages(self, url: str, username: str) -> list[MarketItem]:
        headers = self._headers(username)
        items: list[MarketItem] = []
        start = 0
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT, verify=self._ssl_verify) as client:
                for _ in range(_MAX_PAGES):
                    resp = client.post(
                        f"{url}{_QUERY_PATH}",
                        headers=headers,
                        json={
                            "start": start,
                            "limit": _PAGE_SIZE,
                            "order": "desc",
                            "sort_by": "updated_time",
                            "active": True,
                        },
                    )
                    resp.raise_for_status()
                    payload = resp.json()
                    batch = payload.get("data") or []
                    # 按 tag 过滤测试数据：只保留 baseline 的 skill。
                    items.extend(_to_item(it) for it in batch if _is_baseline(it))
                    total = int(payload.get("total") or 0)
                    start += _PAGE_SIZE
                    if start >= total or not batch:
                        break
        except httpx.HTTPStatusError as e:
            # 定位用：仅在报错时打印实际发出的请求头（含 x-cse-context 里的
            # x-gde-username），用于确认 500 是不是因为 username 为空/异常。
            logger.warning("mythos query 失败，请求头: url=%s%s headers=%s", url, _QUERY_PATH, headers)
            raise SkillError("MYTHOS_ERROR", f"mythos 市场返回 {e.response.status_code}：{e.response.text[:500]}")
        except Exception as e:
            logger.warning("mythos query 失败，请求头: url=%s%s headers=%s", url, _QUERY_PATH, headers)
            raise SkillError("MYTHOS_UNREACHABLE", f"无法连接 mythos 市场: {e}")
        return items

    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        # 先校验用户名再校验地址：两个前置条件都缺时，"没登录"比"没配地址"更贴近用户的
        # 实际处境（地址是出厂配的，用户改不了；登录态是他能处理的）。list_catalog 同序。
        username = self._require_username(ctx)
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT, verify=self._ssl_verify) as client:
                resp = client.get(
                    f"{url}{_DOWNLOAD_PATH}/{remote_id}",
                    headers={
                        **self._headers(username),
                        "Accept": "application/zip,application/octet-stream,*/*",
                    },
                )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise SkillError("REMOTE_SKILL_NOT_FOUND", f"mythos skill '{remote_id}' 不存在")
            raise SkillError("MYTHOS_ERROR", f"mythos 市场返回 {e.response.status_code}：{e.response.text[:500]}")
        except Exception as e:
            raise SkillError("MYTHOS_UNREACHABLE", f"无法连接 mythos 市场: {e}")

        # mythos 部分 skill 的 id 实际没有内容：服务端会返回 200 但 body 为空或不是
        # 合法 zip。这种情况给出清晰报错，而不是让它崩在后续解压环节。
        content = resp.content
        if not content or not zipfile.is_zipfile(io.BytesIO(content)):
            raise SkillError("MYTHOS_SKILL_EMPTY", "该 skill 暂无可下载内容")
        return content

    # import_to_remote 不覆盖：mythos 不支持上传，用基类的 UNSUPPORTED。

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _require_url(self) -> str:
        if not self._base_url:
            raise SkillError("MYTHOS_UNREACHABLE", "mythos 市场地址未配置")
        return self._base_url

    def _require_username(self, ctx: MarketContext) -> str:
        """**这家必须有用户名**——鉴权头里要带，没有它服务端直接 500。

        这个要求原先由市场层替它把关（一句 ``if not username: 跳过``）。那是把一家的
        前置条件写在了不认识这家的地方：换成需要 token 的第四家市场，市场层又得加一个
        它同样不该懂的判断。现在谁的要求谁自己提，市场层只管接住异常。
        """
        name = (ctx.username or "").strip()
        if not name:
            raise SkillError(
                "MYTHOS_NO_USERNAME",
                "mythos 市场需要当前登录用户名（异常，应排查登录/会话）",
            )
        return name

    def _headers(self, username: str) -> dict:
        # x-cse-context 的值是一段 JSON 字符串：租户固定 2000，用户名为当前登录用户。
        # 用紧凑分隔符（无空格）以与文档示例逐字节一致。
        ctx = json.dumps(
            {"x-gde-tenant-id": _TENANT_ID, "x-gde-username": username or ""},
            separators=(",", ":"),
        )
        return {"Content-Type": "application/json", "x-cse-context": ctx}


# ── 字段归一 ──────────────────────────────────────────────────────────────────
# 提成模块级函数（原先是类的 staticmethod）：它们只跟"mythos 的响应长什么样"有关，
# 跟适配器实例没关系，单测时也不必先造一个带 URL 的实例。


def _is_baseline(item: dict) -> bool:
    """tag_names 是字符串列表；含 baseline tag 才保留（可同时带其它 tag）。"""
    tags = item.get("tag_names") or []
    return _BASELINE_TAG in {str(t).strip() for t in tags}


def _localized(value) -> str:
    """display_name / description 都是 {default, zh_CN, en_US}；取 default。"""
    if isinstance(value, dict):
        return value.get("default") or ""
    return value or ""


def _to_item(item: dict) -> MarketItem:
    # 展示名取 display_name.default（与 description 同结构）；缺失时退回 skill_name。
    name = _localized(item.get("display_name")) or (item.get("skill_name") or "")
    return MarketItem(
        id=str(item.get("skill_id", "")),
        name=name,
        description=_localized(item.get("description")) or None,
        updater=_first(item, ("updater", "creatorName", "creator_name", "author")),
        create_time=item.get("updated_time"),
        download_count=_int_or_none(item, ("download_count", "downloadCount", "downloads")),
    )


def _first(item: dict, keys: tuple[str, ...]) -> str | None:
    """取第一个有值的字段。

    各家的字段名不一样（这边叫 updater，netcowork 叫 creatorName），而只认一个名字的
    后果是：界面上作者一栏永远空着，没有任何报错，也看不出是没取到还是本来就没有。
    """
    for k in keys:
        v = item.get(k)
        if v not in (None, ""):
            return str(v)
    return None


def _int_or_none(item: dict, keys: tuple[str, ...]) -> int | None:
    for k in keys:
        v = item.get(k)
        if v is None or v == "":
            continue
        try:
            return int(v)
        except (TypeError, ValueError):
            continue
    return None
