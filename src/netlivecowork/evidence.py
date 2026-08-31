"""Capability-neutral answer evidence handoff.

Providers can discover references while handling a capability invocation, but
the host only learns that the invocation has completed through the core event
stream.  :class:`EvidenceStore` bridges those two points with a short-lived,
bounded ``(session_id, invocation_id)`` entry.  It deliberately knows nothing
about Web capabilities or tool names.

Only small display metadata belongs here.  Queries, fetched page content,
headers, credentials, and other tool payloads must never be recorded.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import threading
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

MAX_EVIDENCE_PER_ANSWER = 32
MAX_EVIDENCE_URL_LENGTH = 4096
MAX_EVIDENCE_TITLE_LENGTH = 200
MAX_EVIDENCE_KIND_LENGTH = 32
MAX_EVIDENCE_PROVIDER_LENGTH = 64

_WHITESPACE_RE = re.compile(r"\s+")
_DISALLOWED_TEXT_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Zl", "Zp"})


def _clean_text(value: object, *, limit: int) -> str:
    """Return bounded, single-line display text without control/bidi marks."""

    if not isinstance(value, str):
        return ""
    normalized = unicodedata.normalize("NFC", value)
    cleaned = "".join(
        " " if unicodedata.category(char) in _DISALLOWED_TEXT_CATEGORIES else char
        for char in normalized
    )
    return _WHITESPACE_RE.sub(" ", cleaned).strip()[:limit]


def _public_http_url(value: object) -> tuple[str, str] | None:
    """Return a canonical public HTTP(S) URL and hostname for display.

    This is a final defensive boundary for provider-produced metadata.  It is
    not a replacement for the request-layer network policy.
    """

    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw or len(raw) > MAX_EVIDENCE_URL_LENGTH:
        return None
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").rstrip(".").lower()
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if scheme not in {"http", "https"} or not hostname:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    if hostname in {"localhost", "localhost.localdomain", "ip6-localhost"} or hostname.endswith(
        (".localhost", ".local", ".internal", ".home.arpa")
    ):
        return None

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        # Reject legacy numeric IPv4 forms (for example 127.1/2130706433) that
        # browsers normalize differently from urllib.
        try:
            socket.inet_aton(hostname)
        except OSError:
            pass
        else:
            return None
        try:
            ascii_host = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            return None
    else:
        if not address.is_global:
            return None
        ascii_host = f"[{address.compressed}]" if address.version == 6 else address.compressed

    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    netloc = ascii_host if port is None or default_port else f"{ascii_host}:{port}"
    canonical = urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, ""))
    if len(canonical) > MAX_EVIDENCE_URL_LENGTH:
        return None
    return canonical, hostname


@dataclass(frozen=True, slots=True)
class EvidenceRef:
    """Small JSON-safe reference produced by any capability.

    ``kind`` is an opaque presentation hint.  The generic host never branches
    on it; the Web provider uses ``fetch`` for a page it has read.
    """

    url: str
    title: str = ""
    kind: str = "reference"
    provider: str = ""
    rank: int | None = None

    def as_dict(self) -> dict[str, Any]:
        safe = _normalize_one(self)
        return safe or {}


def _normalize_one(value: EvidenceRef | Mapping[str, Any]) -> dict[str, Any] | None:
    if isinstance(value, EvidenceRef):
        raw: Mapping[str, Any] = {
            "url": value.url,
            "title": value.title,
            "kind": value.kind,
            "provider": value.provider,
            "rank": value.rank,
        }
    elif isinstance(value, Mapping):
        raw = value
    else:
        return None

    safe_url = _public_http_url(raw.get("url"))
    if safe_url is None:
        return None
    url, domain = safe_url
    title = _clean_text(raw.get("title"), limit=MAX_EVIDENCE_TITLE_LENGTH) or domain
    kind = _clean_text(raw.get("kind"), limit=MAX_EVIDENCE_KIND_LENGTH) or "reference"
    provider = _clean_text(raw.get("provider"), limit=MAX_EVIDENCE_PROVIDER_LENGTH)
    rank_value = raw.get("rank")
    rank = (
        rank_value
        if isinstance(rank_value, int) and not isinstance(rank_value, bool) and rank_value > 0
        else None
    )
    result: dict[str, Any] = {
        "url": url,
        "title": title,
        "domain": domain,
        "kind": kind,
    }
    if provider:
        result["provider"] = provider
    if rank is not None:
        result["rank"] = rank
    return result


def normalize_evidence(
    values: Iterable[EvidenceRef | Mapping[str, Any]],
    *,
    limit: int = MAX_EVIDENCE_PER_ANSWER,
) -> list[dict[str, Any]]:
    """Validate and URL-deduplicate references while preserving their order."""

    bounded_limit = min(max(int(limit), 0), MAX_EVIDENCE_PER_ANSWER)
    if bounded_limit == 0:
        return []
    normalized: list[dict[str, Any]] = []
    index_by_url: dict[str, int] = {}
    for value in values:
        candidate = _normalize_one(value)
        if candidate is None:
            continue
        url = candidate["url"]
        previous = index_by_url.get(url)
        if previous is None:
            index_by_url[url] = len(normalized)
            normalized.append(candidate)
        else:
            # Later capability calls may have a better title or stronger kind
            # for the same page.  Replace metadata without moving its position.
            normalized[previous] = candidate
        if len(normalized) > bounded_limit:
            # Evidence produced later in a turn is normally more specific than
            # early discovery candidates.  Keep the newest unique reference
            # without teaching this generic store about any capability or kind.
            normalized.pop(0)
            index_by_url = {
                item["url"]: index for index, item in enumerate(normalized)
            }
    return normalized


class EvidenceStore:
    """Thread-safe, bounded handoff from capability providers to the host."""

    def __init__(
        self,
        *,
        ttl_seconds: float = 1800.0,
        max_entries: int = 1024,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds <= 0 or max_entries <= 0:
            raise ValueError("ttl_seconds and max_entries must be positive")
        self._ttl_seconds = float(ttl_seconds)
        self._max_entries = int(max_entries)
        self._clock = clock
        self._entries: OrderedDict[
            tuple[str, str], tuple[float, tuple[dict[str, Any], ...]]
        ] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _key(session_id: object, invocation_id: object) -> tuple[str, str] | None:
        session = session_id.strip() if isinstance(session_id, str) else ""
        invocation = invocation_id.strip() if isinstance(invocation_id, str) else ""
        return (session, invocation) if session and invocation else None

    def _purge_expired_locked(self, now: float) -> None:
        for key in [key for key, (deadline, _) in self._entries.items() if deadline <= now]:
            self._entries.pop(key, None)

    def record(
        self,
        session_id: object,
        invocation_id: object,
        references: Iterable[EvidenceRef | Mapping[str, Any]],
    ) -> None:
        """Record small display references for one in-flight invocation."""

        key = self._key(session_id, invocation_id)
        if key is None:
            return
        normalized = normalize_evidence(references)
        now = self._clock()
        with self._lock:
            self._purge_expired_locked(now)
            self._entries.pop(key, None)
            if not normalized:
                return
            while len(self._entries) >= self._max_entries:
                self._entries.popitem(last=False)
            self._entries[key] = (
                now + self._ttl_seconds,
                tuple(dict(reference) for reference in normalized),
            )

    def take(self, session_id: object, invocation_id: object) -> list[dict[str, Any]]:
        """Atomically consume and remove references for an invocation."""

        key = self._key(session_id, invocation_id)
        if key is None:
            return []
        now = self._clock()
        with self._lock:
            self._purge_expired_locked(now)
            entry = self._entries.pop(key, None)
        if entry is None:
            return []
        return [dict(reference) for reference in entry[1]]

    def discard_session(self, session_id: object) -> None:
        """Discard abandoned invocation entries for one session."""

        session = session_id.strip() if isinstance(session_id, str) else ""
        if not session:
            return
        with self._lock:
            for key in [key for key in self._entries if key[0] == session]:
                self._entries.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        now = self._clock()
        with self._lock:
            self._purge_expired_locked(now)
            return len(self._entries)


_DEFAULT_EVIDENCE_STORE = EvidenceStore()


def get_evidence_store() -> EvidenceStore:
    """Return the process-wide store shared by providers and Session entries."""

    return _DEFAULT_EVIDENCE_STORE


__all__ = [
    "EvidenceRef",
    "EvidenceStore",
    "MAX_EVIDENCE_PER_ANSWER",
    "get_evidence_store",
    "normalize_evidence",
]
