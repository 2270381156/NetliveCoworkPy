"""OpenTelemetry tracing for netlivecowork.

Phase 10 §10.6. Optional — only active if opentelemetry packages are installed.

Spans:
- session.create
- task.run
- step.execute (per step)
- llm.complete
- capability.invoke
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Generator

logger = logging.getLogger(__name__)

_tracer: Any = None
_otel_available = False


def configure_tracing(
    service_name: str = "netlivecowork",
    otlp_endpoint: str | None = None,
) -> bool:
    """Configure OpenTelemetry tracing. Returns True if successful."""
    global _tracer, _otel_available
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.resources import Resource

        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource)

        if otlp_endpoint:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            exporter = OTLPSpanExporter(endpoint=otlp_endpoint)
            provider.add_span_processor(BatchSpanProcessor(exporter))

        trace.set_tracer_provider(provider)
        _tracer = trace.get_tracer("CtxWeft.core")
        _otel_available = True
        logger.info("OpenTelemetry tracing configured (service=%s)", service_name)
        return True
    except ImportError:
        logger.debug("opentelemetry not installed — tracing disabled")
        return False


@contextmanager
def span(name: str, attributes: dict[str, Any] | None = None) -> Generator[Any, None, None]:
    """Context manager that creates an OTel span if available, otherwise is a no-op."""
    if _tracer is None or not _otel_available:
        yield None
        return

    from opentelemetry import trace
    with _tracer.start_as_current_span(name) as s:
        if attributes:
            for k, v in attributes.items():
                s.set_attribute(k, str(v))
        yield s


def add_event(name: str, attributes: dict[str, Any] | None = None) -> None:
    """Add an event to the current span."""
    if not _otel_available:
        return
    try:
        from opentelemetry import trace
        current = trace.get_current_span()
        if current:
            current.add_event(name, attributes or {})
    except Exception:
        pass


def record_exception(exc: Exception) -> None:
    """Record an exception on the current span."""
    if not _otel_available:
        return
    try:
        from opentelemetry import trace
        current = trace.get_current_span()
        if current:
            current.record_exception(exc)
    except Exception:
        pass
