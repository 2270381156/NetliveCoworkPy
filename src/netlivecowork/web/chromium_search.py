"""Authenticated loopback client for Cowork's Chromium search bridge."""

from __future__ import annotations

import json
import os
import re
import unicodedata
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .client import is_public_http_url

BRIDGE_URL_ENV = "NLC_WEB_CHROMIUM_BRIDGE_URL"
BRIDGE_TOKEN_ENV = "NLC_WEB_CHROMIUM_BRIDGE_TOKEN"

_MAX_QUERY_CHARS = 500
_MAX_RESULTS = 10
_MAX_RESPONSE_BYTES = 1024 * 1024
_MAX_TOKEN_CHARS = 4096
_WHITESPACE_RE = re.compile(r"\s+")
_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_UNSAFE_TEXT_CATEGORIES = {"Cc", "Cf", "Cs", "Zl", "Zp"}


class ChromiumSearchError(RuntimeError):
    """Stable, redacted error raised at the local bridge boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    rank: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "rank": self.rank,
        }


@dataclass(frozen=True, slots=True)
class SearchResponse:
    query: str
    provider: str
    results: tuple[SearchResult, ...]
    search_page_url: str = ""
    search_page_title: str = ""

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "query": self.query,
            "provider": self.provider,
            "results": [result.to_dict() for result in self.results],
        }
        if self.search_page_url:
            result["search_page"] = {
                "url": self.search_page_url,
                "title": self.search_page_title,
            }
        return result


def _error(code: str, message: str) -> ChromiumSearchError:
    return ChromiumSearchError(code, message)


def _clean_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    value = unicodedata.normalize("NFC", value)
    value = "".join(
        " " if unicodedata.category(char) in _UNSAFE_TEXT_CATEGORIES else char for char in value
    )
    return _WHITESPACE_RE.sub(" ", value).strip()[:limit]


def _normalise_endpoint(value: object) -> str:
    if not isinstance(value, str) or value != value.strip() or "?" in value or "#" in value:
        raise _error("CHROMIUM_SEARCH_CONFIGURATION_ERROR", "Invalid Chromium bridge config.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise _error(
            "CHROMIUM_SEARCH_CONFIGURATION_ERROR", "Invalid Chromium bridge config."
        ) from exc
    if (
        parsed.scheme.lower() != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
    ):
        raise _error("CHROMIUM_SEARCH_CONFIGURATION_ERROR", "Invalid Chromium bridge config.")
    return f"http://127.0.0.1:{port}"


def _normalise_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if len(value) > 4096 or not is_public_http_url(value):
        return None
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path or "/", parsed.query, ""))


class ChromiumSearchClient:
    """POST search requests directly to an authenticated local Chromium host."""

    def __init__(
        self,
        endpoint: str,
        token: str,
        *,
        opener: Callable[..., Any] | Any | None = None,
        timeout_sec: float = 30.0,
        max_response_bytes: int = _MAX_RESPONSE_BYTES,
    ) -> None:
        self._endpoint = _normalise_endpoint(endpoint)
        if (
            not isinstance(token, str)
            or not token
            or len(token) > _MAX_TOKEN_CHARS
            or any(ord(char) < 33 or ord(char) > 126 for char in token)
        ):
            raise _error("CHROMIUM_SEARCH_CONFIGURATION_ERROR", "Invalid Chromium bridge config.")
        if not 0 < float(timeout_sec) <= 60:
            raise ValueError("timeout_sec must be between 0 and 60")
        if not 0 < max_response_bytes <= 4 * _MAX_RESPONSE_BYTES:
            raise ValueError("max_response_bytes is outside the supported range")
        self._token = token
        self._timeout_sec = float(timeout_sec)
        self._max_response_bytes = int(max_response_bytes)
        if opener is None:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._open = opener if callable(opener) else getattr(opener, "open", None)
        if not callable(self._open):
            raise TypeError("opener must be callable or provide open()")

    def __repr__(self) -> str:
        return "ChromiumSearchClient(endpoint=<loopback>, token=<redacted>)"

    @classmethod
    def from_env(cls, **kwargs: Any) -> ChromiumSearchClient | None:
        """Consume credentials so tool subprocesses cannot inherit the bridge."""

        endpoint = os.environ.pop(BRIDGE_URL_ENV, "")
        token = os.environ.pop(BRIDGE_TOKEN_ENV, "")
        if not endpoint and not token:
            return None
        if not endpoint or not token:
            raise _error("CHROMIUM_SEARCH_CONFIGURATION_ERROR", "Invalid Chromium bridge config.")
        return cls(endpoint, token, **kwargs)

    def search(
        self,
        query: str,
        *,
        max_results: int = 8,
        language: str = "zh-CN",
    ) -> SearchResponse:
        query = _clean_text(query, _MAX_QUERY_CHARS + 1)
        if not query or len(query) > _MAX_QUERY_CHARS:
            raise _error("CHROMIUM_SEARCH_INVALID_ARGUMENT", "Invalid web search query.")
        if isinstance(max_results, bool) or not isinstance(max_results, int):
            raise _error("CHROMIUM_SEARCH_INVALID_ARGUMENT", "Invalid web search result limit.")
        if not 1 <= max_results <= _MAX_RESULTS:
            raise _error("CHROMIUM_SEARCH_INVALID_ARGUMENT", "Invalid web search result limit.")
        if not isinstance(language, str) or not _LANGUAGE_RE.fullmatch(language.strip()):
            raise _error("CHROMIUM_SEARCH_INVALID_ARGUMENT", "Invalid web search language.")
        language = language.strip()

        body = json.dumps(
            {"query": query, "max_results": max_results, "language": language},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        request = urllib.request.Request(
            f"{self._endpoint}/v1/search",
            data=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        response: Any | None = None
        try:
            response = self._open(request, timeout=self._timeout_sec)
            status = getattr(response, "status", None) or response.getcode()
            if not isinstance(status, int) or not 200 <= status < 300:
                raise _error("CHROMIUM_SEARCH_REJECTED", "Chromium search was rejected.")
            raw = response.read(self._max_response_bytes + 1)
            if not isinstance(raw, bytes) or len(raw) > self._max_response_bytes:
                raise _error("CHROMIUM_SEARCH_RESPONSE_TOO_LARGE", "Search response was too large.")
        except ChromiumSearchError:
            raise
        except urllib.error.HTTPError as exc:
            raise _error("CHROMIUM_SEARCH_REJECTED", "Chromium search was rejected.") from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                raise _error("CHROMIUM_SEARCH_TIMEOUT", "Chromium search timed out.") from exc
            raise _error("CHROMIUM_SEARCH_UNAVAILABLE", "Chromium search is unavailable.") from exc
        except TimeoutError as exc:
            raise _error("CHROMIUM_SEARCH_TIMEOUT", "Chromium search timed out.") from exc
        except Exception as exc:
            raise _error("CHROMIUM_SEARCH_UNAVAILABLE", "Chromium search is unavailable.") from exc
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()

        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _error(
                "CHROMIUM_SEARCH_INVALID_RESPONSE", "Invalid Chromium search response."
            ) from exc
        if not isinstance(document, Mapping) or document.get("ok") is not True:
            raise _error("CHROMIUM_SEARCH_INVALID_RESPONSE", "Invalid Chromium search response.")
        raw_results = document.get("results")
        if not isinstance(raw_results, list):
            raise _error("CHROMIUM_SEARCH_INVALID_RESPONSE", "Invalid Chromium search response.")

        provider = _clean_text(document.get("provider"), 64) or "chromium"
        raw_search_page = document.get("search_page")
        search_page_url = ""
        search_page_title = ""
        if isinstance(raw_search_page, Mapping):
            search_page_url = _normalise_url(raw_search_page.get("url")) or ""
            if search_page_url:
                search_page_title = _clean_text(raw_search_page.get("title"), 300)
        results: list[SearchResult] = []
        seen: set[str] = set()
        for item in raw_results:
            if not isinstance(item, Mapping):
                continue
            url = _normalise_url(item.get("url"))
            parsed_url = urlsplit(url) if url else None
            key = (
                parsed_url._replace(netloc=parsed_url.netloc.lower()).geturl() if parsed_url else ""
            )
            if not url or key in seen:
                continue
            seen.add(key)
            results.append(
                SearchResult(
                    title=_clean_text(item.get("title"), 300) or (urlsplit(url).hostname or url),
                    url=url,
                    snippet=_clean_text(item.get("snippet"), 1200),
                    rank=len(results) + 1,
                )
            )
            if len(results) >= max_results:
                break
        return SearchResponse(
            query=query,
            provider=provider,
            results=tuple(results),
            search_page_url=search_page_url if results else "",
            search_page_title=search_page_title if results else "",
        )
