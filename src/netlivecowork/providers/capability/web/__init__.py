"""Public assembly entry point for the lightweight Web capability."""

from .provider import (
    WEB_FETCH_ID,
    WEB_SEARCH_ID,
    WebCapabilityProvider,
    create_web_provider_from_env,
)

__all__ = [
    "WEB_FETCH_ID",
    "WEB_SEARCH_ID",
    "WebCapabilityProvider",
    "create_web_provider_from_env",
]
