"""Lightweight static page extraction.

This module has no Cowork runtime dependencies. It can be tested with an injected
transport and reused by a capability adapter without changing Session, HITL, or the
application architecture.
"""
from __future__ import annotations

import html as html_module
import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import parse_qsl, quote, unquote, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from .client import (
    RETRYABLE_EXCEPTIONS,
    RETRYABLE_STATUS,
    RequestsTransport,
    ResponseLike,
    UrllibTransport,
    WebTransport,
    is_proxy_blocked,
    is_public_http_url,
    response_text,
)

NETWORK_FALLBACK_STATUS = RETRYABLE_STATUS | {407, 504}


class WebRetrievalError(RuntimeError):
    """Base error surfaced to the web capability as a recoverable result."""


class ProxyBlockedError(WebRetrievalError):
    """The corporate proxy returned its block notification page."""


@dataclass(frozen=True, slots=True)
class FetchResult:
    url: str
    title: str
    format: str
    content_type: str
    content: str
    status_code: int
    api_urls: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class WebRetrievalService:
    """Fetch and extract one public static page for ``web_fetch``."""

    def __init__(
        self,
        transport: WebTransport | None = None,
        *,
        fallback_fetch_transport: WebTransport | None = None,
    ) -> None:
        self.transport = transport if transport is not None else RequestsTransport()
        self.fallback_fetch_transport = (
            fallback_fetch_transport
            if fallback_fetch_transport is not None
            else UrllibTransport() if transport is None else None
        )

    def fetch(self, url: str) -> FetchResult:
        requested_url = encode_non_ascii_path(str(url or "").strip())
        if not is_public_http_url(requested_url):
            raise ValueError("url must be an absolute HTTP or HTTPS URL")

        response = self._fetch_response(requested_url)
        text = response_text(response)
        if is_proxy_blocked(response, text):
            raise ProxyBlockedError(
                "The page was blocked by the proxy; use a public alternative such as Wikipedia "
                "or another reputable source."
            )
        status = int(getattr(response, "status_code", 0) or 0)
        if not 200 <= status < 300 or status in {204, 205}:
            raise WebRetrievalError(f"HTTP {status}; choose another public source")

        final_url = str(getattr(response, "url", requested_url) or requested_url)
        if not is_public_http_url(final_url):
            raise WebRetrievalError("The page redirected outside the public web")
        if not text.strip():
            raise WebRetrievalError("The page returned no usable content")

        headers: Mapping[str, str] = getattr(response, "headers", {}) or {}
        content_type = _header_value(headers, "content-type")

        if _is_json_content_type(content_type):
            content = _format_json(response, text)
            return FetchResult(
                url=final_url,
                title=final_url,
                format="json",
                content_type=content_type,
                content=content,
                status_code=status,
            )

        if "html" not in content_type.lower() and not _looks_like_html(text):
            if not _is_text_content_type(content_type):
                raise WebRetrievalError("The URL returned unsupported binary content")
            content = _normalise_lines(text)
            if not content or _is_missing_page(final_url, "", content):
                raise WebRetrievalError("The page does not contain a usable resource")
            return FetchResult(
                url=final_url,
                title=final_url,
                format="text",
                content_type=content_type,
                content=content,
                status_code=status,
            )

        title, cleaned = clean_html(text)
        api_urls = tuple(discover_api_urls(text, final_url))
        # Per the skill, short visible text in a >50KB document is the signal to decode
        # Next.js App Router's RSC stream instead of reporting an empty page.
        payload = ""
        if len(cleaned) < 500 and len(text) > 50_000:
            payload = decode_rsc_payload(text)
        content = payload or cleaned
        if not _html_has_content(title, content):
            raise WebRetrievalError("The page returned no usable HTML content")
        if _is_missing_page(final_url, title, content):
            raise WebRetrievalError("The page is a 404/410 placeholder")
        if _is_mismatched_page(requested_url, final_url, title, content):
            raise WebRetrievalError("The returned page does not match the requested resource")

        return FetchResult(
            url=final_url,
            title=title or final_url,
            format="rsc" if payload else "html",
            content_type=content_type,
            content=content,
            status_code=status,
            api_urls=api_urls,
        )

    def _fetch_response(self, url: str) -> ResponseLike:
        """Use the enterprise proxy first, then the system/direct path on IO failure."""

        try:
            response = self.transport.get(url, timeout=(15, 30))
        except RETRYABLE_EXCEPTIONS:
            if self.fallback_fetch_transport is None:
                raise
            return self.fallback_fetch_transport.get(url, timeout=30)

        status = int(getattr(response, "status_code", 0) or 0)
        if status in NETWORK_FALLBACK_STATUS and self.fallback_fetch_transport is not None:
            return self.fallback_fetch_transport.get(url, timeout=30)
        return response


def encode_non_ascii_path(url: str) -> str:
    if not any(ord(char) > 127 for char in url):
        return url
    parts = urlsplit(url)
    encoded_path = quote(parts.path, safe="/%:@")
    return urlunsplit((parts.scheme, parts.netloc, encoded_path, parts.query, parts.fragment))


def clean_html(html_text: str) -> tuple[str, str]:
    soup = BeautifulSoup(html_text, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for tag in soup(
        ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "ref"]
    ):
        tag.decompose()
    for selector in (
        "[role='navigation']",
        "[aria-label='advertisement']",
        ".advertisement",
        ".ads",
        ".mw-editsection",
        "sup.reference",
    ):
        for tag in soup.select(selector):
            tag.decompose()
    text = soup.get_text("\n")
    text = re.sub(r"\[(?:编辑|edit)\]", "", text, flags=re.I)
    return title, _normalise_lines(text)


def decode_rsc_payload(html_text: str) -> str:
    fragments = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', html_text, flags=re.S)
    decoded: list[str] = []
    for fragment in fragments:
        try:
            decoded.append(json.loads('"' + fragment + '"'))
        except (json.JSONDecodeError, TypeError):
            continue
    return "".join(decoded)


def discover_api_urls(html_text: str, page_url: str, *, limit: int = 10) -> list[str]:
    """Expose public API hints from HTML without probing or crawling extra paths."""

    candidates = re.findall(r"fetch\([\"']([^\"']+)[\"']", html_text)
    candidates.extend("/" + value for value in re.findall(r"[\"']/(api/[^\"']+)[\"']", html_text))
    found: list[str] = []
    for value in candidates:
        absolute = urljoin(page_url, html_module.unescape(value))
        if is_public_http_url(absolute) and absolute not in found:
            found.append(absolute)
            if len(found) >= limit:
                break
    return found


def _normalise_lines(value: str) -> str:
    lines = [re.sub(r"\s+", " ", line).strip() for line in value.splitlines()]
    return "\n".join(line for line in lines if line)


def _format_json(response: ResponseLike, text: str) -> str:
    json_method = getattr(response, "json", None)
    try:
        value = json_method() if callable(json_method) else json.loads(text)
    except (ValueError, TypeError):
        value = json.loads(text)
    if _json_is_missing(value):
        raise WebRetrievalError("The JSON response reports a missing resource")
    if not _json_has_content(value):
        raise WebRetrievalError("The page returned no usable JSON content")
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _json_has_content(value: Any) -> bool:
    if value is None or value == "" or value == [] or value == {}:
        return False
    if isinstance(value, Mapping):
        content_keys = {"article", "body", "content", "data", "items", "records", "results"}
        present = [raw for key, raw in value.items() if str(key).casefold() in content_keys]
        if present:
            return any(_json_has_content(raw) for raw in present)
        metadata = {"code", "status", "error", "message", "detail", "ok", "success"}
        return any(
            str(key).casefold() not in metadata and _json_has_content(raw)
            for key, raw in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_json_has_content(item) for item in value)
    return True


def _json_is_missing(value: Any) -> bool:
    if not isinstance(value, Mapping) or _json_has_content(value):
        return False
    nested = value.get("error")
    if isinstance(nested, Mapping):
        value = nested
    message = " ".join(
        str(raw)
        for key, raw in value.items()
        if str(key).casefold() in {"error", "message", "detail", "reason"}
    )
    code = next(
        (str(raw) for key, raw in value.items() if str(key).casefold() in {"code", "status"}),
        "",
    )
    return code in {"404", "410"} or bool(re.search(r"\b(?:not found|gone)\b", message, re.I))


def _header_value(headers: Mapping[str, str], name: str) -> str:
    return next(
        (str(value or "") for key, value in headers.items() if str(key).casefold() == name),
        "",
    )


def _html_has_content(title: str, content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if title and lines and lines[0].casefold() == title.strip().casefold():
        lines.pop(0)
    return bool(lines)


_MISSING_TITLE_RE = re.compile(
    r"^(?:(?:404|410)(?:\s*[,，:：-]?\s*(?:not found|page not found|content not found|"
    r"gone|error|页面不存在|网页不存在|页面未找到))?"
    r"|page not found|not found|页面不存在|网页不存在|页面未找到"
    r"|(?:404\s*[,，:：-]?\s*)?您(?:所)?访问的(?:页面|网页).{0,12}"
    r"(?:不存在|找不到|未找到|已删除|已失效))"
    r"[!！。.]?(?:\s*[_|｜]\s*[^_|｜]{1,80})?$",
    re.I,
)
_MISSING_BODY_RE = re.compile(
    r"(?:page|resource|content).{0,30}(?:not found|does not exist|removed|gone)"
    r"|(?:页面|网页|内容|文章|资源).{0,16}(?:不存在|找不到|未找到|已删除|已失效)",
    re.I,
)


def _is_missing_page(url: str, title: str, content: str) -> bool:
    normal_title = re.sub(r"\s+", " ", html_module.unescape(title)).strip()
    if normal_title and _MISSING_TITLE_RE.fullmatch(normal_title):
        return True
    dash_suffix = re.fullmatch(
        r"(?:page not found|页面不存在)\s+-\s+(.+)", normal_title, re.I
    )
    if dash_suffix and not re.search(
        r"\b(?:how|why|fix|guide)\b|解决|修复|含义|原因", dash_suffix[1], re.I
    ):
        return True
    path = urlsplit(url).path.rstrip("/").casefold()
    return bool(re.search(r"/(?:404|410)(?:\.html?)?$", path)) and bool(
        _MISSING_BODY_RE.search(content)
    )


_SLUG_STOP_WORDS = {
    "analysis", "article", "forecast", "global", "growth", "industry", "market",
    "markets", "news", "outlook", "release", "report", "research", "share", "size",
    "the", "trend", "update", "with",
}


def _is_mismatched_page(requested_url: str, final_url: str, title: str, content: str) -> bool:
    requested, final = urlsplit(requested_url), urlsplit(final_url)
    if _is_search_url(final) and not _is_search_url(requested):
        return True

    requested_slug, requested_id = _slug_and_id(requested.path)
    final_slug, final_id = _slug_and_id(final.path)
    requested_tokens = _topic_tokens(requested_slug)
    final_tokens = _topic_tokens(final_slug)
    if (
        requested_id
        and requested_id == final_id
        and requested_tokens
        and final_tokens
        and requested_tokens.isdisjoint(final_tokens)
    ):
        return True

    # For an unchanged descriptive English article URL, reject only a page whose
    # title and leading content share none of at least three meaningful slug words.
    if requested.path == final.path and len(requested_tokens) >= 3:
        page_tokens = _topic_tokens(f"{title} {content[:2000]}")
        return bool(page_tokens) and requested_tokens.isdisjoint(page_tokens)
    return False


def _is_search_url(parts: Any) -> bool:
    if {name.casefold() for name, _ in parse_qsl(parts.query)} & {"q", "query", "search"}:
        return True
    return any(
        re.search(r"(?:^|-)search(?:-|$)", segment.casefold())
        for segment in unquote(parts.path).split("/")
    )


def _slug_and_id(path: str) -> tuple[str, str]:
    decoded = unquote(path).rstrip("/")
    if not decoded or not decoded.isascii():
        return "", ""
    stem = re.sub(r"\.(?:aspx?|html?|php|jsp)$", "", decoded.rsplit("/", 1)[-1], flags=re.I)
    match = re.search(r"(?:^|[-_])(\d{4,})$", stem)
    return (stem, "") if not match else (stem[: match.start()].rstrip("-_"), match.group(1))


def _topic_tokens(value: str) -> set[str]:
    tokens: set[str] = set()
    for raw in re.findall(r"[a-z]+", value.casefold()):
        if len(raw) < 4 or raw in _SLUG_STOP_WORDS:
            continue
        token = raw[:-1] if len(raw) > 4 and raw.endswith("s") else raw
        tokens.add("agent" if token.startswith("agent") else token)
    return tokens


def _is_json_content_type(content_type: str) -> bool:
    mime = content_type.partition(";")[0].strip().lower()
    return mime.endswith("/json") or mime.endswith("+json")


def _is_text_content_type(content_type: str) -> bool:
    mime = content_type.partition(";")[0].strip().lower()
    return not mime or mime.startswith("text/") or mime.endswith("+xml")


def _looks_like_html(value: str) -> bool:
    head = value[:500].lower()
    return "<!doctype html" in head or "<html" in head or "<body" in head
