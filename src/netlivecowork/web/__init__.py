"""Lightweight static-page retrieval helpers."""

from .chromium_search import (
    ChromiumSearchClient,
    ChromiumSearchError,
    SearchResponse,
    SearchResult,
)
from .client import RequestsTransport, UrllibTransport, WebTransport
from .service import (
    FetchResult,
    ProxyBlockedError,
    WebRetrievalError,
    WebRetrievalService,
)

__all__ = [
    "ChromiumSearchClient",
    "ChromiumSearchError",
    "FetchResult",
    "ProxyBlockedError",
    "RequestsTransport",
    "SearchResponse",
    "SearchResult",
    "UrllibTransport",
    "WebRetrievalError",
    "WebRetrievalService",
    "WebTransport",
]
