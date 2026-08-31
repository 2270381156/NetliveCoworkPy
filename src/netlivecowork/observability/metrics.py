"""Prometheus metrics for netlivecowork.

Phase 10 §10.5. Optional — only active if prometheus_client is installed.

Key SLIs:
- NLC_sessions_total (counter)
- NLC_tasks_total (counter)
- NLC_step_duration_seconds (histogram)
- NLC_llm_tokens_total (counter)
- NLC_capability_invocations_total (counter)
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_metrics_available = False
_sessions_total = None
_tasks_total = None
_step_duration = None
_llm_tokens_total = None
_capability_invocations_total = None


def _init_metrics() -> bool:
    global _metrics_available, _sessions_total, _tasks_total
    global _step_duration, _llm_tokens_total, _capability_invocations_total

    try:
        from prometheus_client import Counter, Histogram, start_http_server

        _sessions_total = Counter(
            "NLC_sessions_total",
            "Total sessions created",
            ["tenant_id", "template_id"],
        )
        _tasks_total = Counter(
            "NLC_tasks_total",
            "Total tasks by outcome",
            ["outcome"],
        )
        _step_duration = Histogram(
            "NLC_step_duration_seconds",
            "Step execution duration in seconds",
            ["step_name"],
            buckets=[0.1, 0.5, 1, 5, 10, 30, 60, 120],
        )
        _llm_tokens_total = Counter(
            "NLC_llm_tokens_total",
            "Total LLM tokens consumed",
            ["kind"],  # "prompt" | "completion"
        )
        _capability_invocations_total = Counter(
            "NLC_capability_invocations_total",
            "Total capability invocations",
            ["provider", "outcome"],
        )
        _metrics_available = True
        logger.info("Prometheus metrics initialized")
        return True
    except ImportError:
        logger.debug("prometheus_client not installed — metrics disabled")
        return False


def start_metrics_server(port: int = 9090) -> None:
    """Start Prometheus metrics HTTP server on given port."""
    if not _metrics_available:
        _init_metrics()
    if _metrics_available:
        try:
            from prometheus_client import start_http_server
            start_http_server(port)
            logger.info("Prometheus metrics server started on :%d", port)
        except Exception:
            logger.exception("Failed to start metrics server")


def record_session_created(tenant_id: str, template_id: str) -> None:
    if _sessions_total:
        _sessions_total.labels(tenant_id=tenant_id, template_id=template_id).inc()


def record_task_finished(outcome: str) -> None:
    if _tasks_total:
        _tasks_total.labels(outcome=outcome).inc()


def record_llm_tokens(prompt: int, completion: int) -> None:
    if _llm_tokens_total:
        _llm_tokens_total.labels(kind="prompt").inc(prompt)
        _llm_tokens_total.labels(kind="completion").inc(completion)


def record_capability_invocation(provider: str, outcome: str) -> None:
    if _capability_invocations_total:
        _capability_invocations_total.labels(provider=provider, outcome=outcome).inc()


class StepTimer:
    """Context manager for timing step execution."""

    def __init__(self, step_name: str) -> None:
        self._step_name = step_name
        self._timer: Any = None

    def __enter__(self) -> "StepTimer":
        if _step_duration:
            self._timer = _step_duration.labels(step_name=self._step_name).time()
            self._timer.__enter__()
        return self

    def __exit__(self, *args: Any) -> None:
        if self._timer:
            self._timer.__exit__(*args)


# Initialize on import
_init_metrics()
