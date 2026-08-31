"""Skill-compatible HTTP transport for lightweight static-page retrieval.

The implementation intentionally mirrors the fetch path from the reference skill: requests inherits
the user's proxy credentials, falls back to the corporate proxy when no proxy variable
exists, uses a browser user agent, disables TLS verification for the intercepting proxy,
and retries transient proxy/network failures three times.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import time
import urllib.request
import warnings
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

import requests
from urllib3.exceptions import InsecureRequestWarning

DEFAULT_PROXY = "http://proxysg.huawei.com:8080"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
}
RETRYABLE_STATUS = frozenset({502, 503})
RETRYABLE_EXCEPTIONS = (
    requests.exceptions.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.Timeout,
    requests.exceptions.ProxyError,
)
REDIRECT_STATUS = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 5


def is_public_http_url(value: str) -> bool:
    """Lightweight public-URL boundary shared by fetch and redirects."""

    try:
        parts = urlsplit(value)
        hostname = (parts.hostname or "").rstrip(".").lower()
        if parts.port is not None and not (1 <= parts.port <= 65535):
            return False
    except (TypeError, ValueError):
        return False
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not hostname
        or parts.username is not None
        or parts.password is not None
    ):
        return False
    if hostname in {"localhost", "localhost.localdomain", "ip6-localhost"} or hostname.endswith(
        (".localhost", ".local", ".internal", ".home.arpa")
    ):
        return False
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            socket.inet_aton(hostname)
        except OSError:
            return True
        return False
    return address.is_global


class ResponseLike(Protocol):
    status_code: int
    url: str
    headers: Mapping[str, str]
    content: bytes
    text: str


class WebTransport(Protocol):
    """Small injection seam used by the retrieval service and offline tests."""

    def get(
        self,
        url: str,
        *,
        timeout: float | tuple[float, float] = (15, 40),
        headers: Mapping[str, str] | None = None,
    ) -> ResponseLike: ...


@dataclass(frozen=True, slots=True)
class BufferedResponse:
    """Small response value used by the system/direct fallback path."""

    status_code: int
    url: str
    headers: Mapping[str, str]
    content: bytes
    text: str = ""


class UrllibTransport:
    """System-proxy/direct fallback transport for static page fetching.

    ``urllib`` deliberately uses its default opener so the fallback can use proxy
    settings from the host environment when present and connect directly otherwise.
    """

    def __init__(
        self,
        *,
        retries: int = 3,
        backoff: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self.retries = max(1, retries)
        self.backoff = backoff
        self._sleep = sleep
        self._opener = opener

    def get(
        self,
        url: str,
        *,
        timeout: float | tuple[float, float] = 25,
        headers: Mapping[str, str] | None = None,
    ) -> ResponseLike:
        if not is_public_http_url(url):
            raise ValueError("url must be a public HTTP or HTTPS URL")
        request_headers = dict(DEFAULT_HEADERS)
        if headers:
            request_headers.update(headers)
        timeout_value = float(timeout[-1] if isinstance(timeout, tuple) else timeout)

        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            response: Any | None = None
            try:
                request = urllib.request.Request(url, headers=request_headers)
                response = self._opener(request, timeout=timeout_value)
                content = response.read()
                final_url = str(response.geturl())
                if not is_public_http_url(final_url):
                    raise ValueError("web redirect left the public internet")
                status = int(getattr(response, "status", response.getcode()) or 0)
                response_headers = dict(getattr(response, "headers", {}) or {})
                buffered = BufferedResponse(
                    status_code=status,
                    url=final_url,
                    headers=response_headers,
                    content=content,
                )
                if status in RETRYABLE_STATUS and attempt < self.retries:
                    self._sleep(self.backoff**attempt)
                    continue
                return buffered
            except Exception as exc:
                last_error = exc
                if attempt >= self.retries:
                    raise
                self._sleep(self.backoff**attempt)
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    close()

        if last_error is not None:
            raise last_error
        raise RuntimeError("web request failed without a response")


class RequestsTransport:
    """``requests.Session`` adapter with the exact retry/proxy rules from the skill."""

    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        proxy: str | None = None,
        retries: int = 3,
        backoff: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        # An explicitly injected session is a test seam.  Production requests
        # create a fresh Session per attempt, matching the Skill and preventing
        # cookies learned from one Cowork session leaking into another.
        self.session = session
        if self.session is not None:
            self.session.trust_env = True
        self.proxy = (
            proxy
            or os.environ.get("http_proxy")
            or os.environ.get("https_proxy")
            or os.environ.get("HTTP_PROXY")
            or os.environ.get("HTTPS_PROXY")
            or DEFAULT_PROXY
        )
        self.proxies = {"http": self.proxy, "https": self.proxy}
        self.retries = max(1, retries)
        self.backoff = backoff
        self._sleep = sleep

    def get(
        self,
        url: str,
        *,
        timeout: float | tuple[float, float] = (15, 40),
        headers: Mapping[str, str] | None = None,
    ) -> ResponseLike:
        if not is_public_http_url(url):
            raise ValueError("url must be a public HTTP or HTTPS URL")
        request_headers = dict(DEFAULT_HEADERS)
        if headers:
            request_headers.update(headers)

        last_error: BaseException | None = None
        for attempt in range(1, self.retries + 1):
            request_session = self.session or requests.Session()
            request_session.trust_env = True
            try:
                current_url = url
                for redirect_count in range(MAX_REDIRECTS + 1):
                    # The skill requires verify=False behind its intercepting proxy.
                    # Suppression remains local to this request.
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", InsecureRequestWarning)
                        response = request_session.get(
                            current_url,
                            proxies=self.proxies,
                            headers=request_headers,
                            timeout=timeout,
                            verify=False,
                            allow_redirects=False,
                        )
                    location = response.headers.get("location") or response.headers.get("Location")
                    if response.status_code not in REDIRECT_STATUS or not location:
                        break
                    if redirect_count >= MAX_REDIRECTS:
                        raise ValueError("too many web redirects")
                    current_url = urljoin(str(response.url or current_url), str(location))
                    if not is_public_http_url(current_url):
                        raise ValueError("web redirect left the public internet")
                if response.status_code in RETRYABLE_STATUS and attempt < self.retries:
                    self._sleep(self.backoff**attempt)
                    continue
                return response
            except RETRYABLE_EXCEPTIONS as exc:
                last_error = exc
                if attempt >= self.retries:
                    raise
                self._sleep(self.backoff**attempt)
            finally:
                if self.session is None:
                    request_session.close()

        if last_error is not None:
            raise last_error
        raise RuntimeError("web request failed without a response")


def response_text(response: ResponseLike) -> str:
    """Decode a response using the skill's UTF-8 -> GB18030 -> Latin-1 fallback."""

    raw: Any = getattr(response, "content", b"")
    if isinstance(raw, str):
        return raw
    if raw:
        for encoding in ("utf-8", "gb18030", "latin-1"):
            try:
                return raw.decode(encoding)
            except (UnicodeDecodeError, LookupError):
                continue
        return raw.decode("utf-8", errors="ignore")
    return str(getattr(response, "text", "") or "")


def is_proxy_blocked(response: ResponseLike, text: str | None = None) -> bool:
    """Detect the status-200 proxy block pages called out by the skill."""

    body = response_text(response) if text is None else text
    final_url = str(getattr(response, "url", "") or "").lower()
    return (
        "HIS Proxy Notification" in body
        or "proxycontrolwarn" in final_url
        or (int(getattr(response, "status_code", 0) or 0) == 200 and not response.content)
    )
