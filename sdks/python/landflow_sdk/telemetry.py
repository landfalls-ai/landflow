"""Tracing, metrics and configuration for one plugin (docs/observability.md).

``Telemetry`` is created by ``Plugin`` from the environment. It works in two modes:

* **built-in** (no ``opentelemetry`` packages): it parses W3C ``traceparent``
  itself, generates span ids, samples per ``OTEL_TRACES_SAMPLER``, writes a
  ``span.end`` log line per finished span and keeps metrics in memory for
  ``GET /metrics``.
* **OpenTelemetry** (``pip install 'landflow-sdk[otel]'``): spans are real OTel
  spans (so third-party instrumentation joins the same trace), exported over
  OTLP when ``OTEL_EXPORTER_OTLP_ENDPOINT`` (or the per-signal variable) is set;
  metrics are mirrored to an OTLP metric exporter. ``span.end`` lines and
  ``/metrics`` work the same as in built-in mode.

``OTEL_SDK_DISABLED=true`` makes spans and metrics no-ops; incoming trace
context is still passed through to outbound calls.
"""

from __future__ import annotations

import contextvars
import logging
import os
import random
import re
import time
import traceback
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping

from ._version import __version__
from .logs import emit_span_end, set_ids_provider
from .metrics import MetricsRegistry
from .protocol import TRACE_HEADERS  # noqa: F401 - re-exported
from .redact import redact_text, redact_value

log = logging.getLogger("landflow_sdk.telemetry")

SPAN_KINDS = ("internal", "server", "client", "producer", "consumer")
SDK_NAME = "landflow-sdk-python"

_TRACEPARENT_RE = re.compile(r"^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s*$")
_ZERO_TRACE = "0" * 32
_ZERO_SPAN = "0" * 16
_MAX_TRACESTATE = 512
_MAX_BAGGAGE = 8192
_FALSE = {"false", "0", "no", "off"}
_TRUE = {"true", "1", "yes", "on"}


# ---------------------------------------------------------------------------
# W3C trace context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SpanContext:
    """The propagated identity of a span. Empty ids mean "no trace" (telemetry disabled, no parent)."""

    trace_id: str
    span_id: str
    sampled: bool = True
    tracestate: str = ""
    baggage: str = ""
    remote: bool = False

    @property
    def is_valid(self) -> bool:
        return bool(self.trace_id and self.span_id)


_EMPTY_CONTEXT = SpanContext("", "", sampled=False)


def parse_traceparent(value: Any) -> tuple[str, str, bool] | None:
    """``"00-<32 hex>-<16 hex>-<2 hex>"`` -> ``(trace_id, span_id, sampled)``; ``None`` if invalid."""
    if not isinstance(value, str):
        return None
    match = _TRACEPARENT_RE.match(value)
    if not match:
        return None
    version, trace_id, span_id, flags, rest = match.groups()
    if version == "ff" or (version == "00" and rest) or trace_id == _ZERO_TRACE or span_id == _ZERO_SPAN:
        return None
    return trace_id, span_id, bool(int(flags, 16) & 0x01)


def format_traceparent(trace_id: str, span_id: str, sampled: bool) -> str:
    return f"00-{trace_id}-{span_id}-{'01' if sampled else '00'}"


def header_value(headers: Any, name: str) -> str | None:
    """Case-insensitive lookup in an HTTP message, a dict or gRPC metadata pairs."""
    if not headers:
        return None
    if isinstance(headers, (list, tuple)):
        headers = dict(headers)
    getter = getattr(headers, "get", None)
    if getter is not None:
        value = getter(name)
        if value is not None:
            return value if isinstance(value, str) else None
    items = getattr(headers, "items", None)
    if items is not None:
        for key, value in items():
            if isinstance(key, str) and key.lower() == name and isinstance(value, str):
                return value
    return None


def extract(headers: Any) -> SpanContext | None:
    """The remote parent carried in ``traceparent`` / ``tracestate`` / ``baggage``, or ``None``."""
    parsed = parse_traceparent(header_value(headers, "traceparent"))
    if parsed is None:
        return None
    trace_id, span_id, sampled = parsed
    tracestate = (header_value(headers, "tracestate") or "").strip()
    baggage = (header_value(headers, "baggage") or "").strip()
    return SpanContext(
        trace_id,
        span_id,
        sampled,
        tracestate if len(tracestate) <= _MAX_TRACESTATE else "",
        baggage if len(baggage) <= _MAX_BAGGAGE else "",
        remote=True,
    )


def _new_trace_id() -> str:
    while True:
        value = random.getrandbits(128)
        if value:
            return f"{value:032x}"


def _new_span_id() -> str:
    while True:
        value = random.getrandbits(64)
        if value:
            return f"{value:016x}"


# ---------------------------------------------------------------------------
# Spans
# ---------------------------------------------------------------------------

_current_span: contextvars.ContextVar["Span | None"] = contextvars.ContextVar("landflow_current_span", default=None)
_otel_trace: Any = None  # the opentelemetry.trace module once a Telemetry uses it


def current_span() -> "Span | None":
    """The SDK span active in this context (a server span or a ``ctx.span`` child)."""
    return _current_span.get()


def current_ids() -> tuple[str | None, str | None]:
    """``(trace_id, span_id)`` of the active span, for log lines."""
    span = _current_span.get()
    if span is not None and span.context.is_valid:
        return span.trace_id, span.span_id
    if _otel_trace is not None:
        context = _otel_trace.get_current_span().get_span_context()
        if context.is_valid:
            return f"{context.trace_id:032x}", f"{context.span_id:016x}"
    return None, None


set_ids_provider(current_ids)


def _attribute(value: Any) -> Any:
    """Coerce to an OTel attribute value (str, bool, int, float or a homogeneous list)."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        items = [v for v in value if v is not None]
        if all(isinstance(v, (str, bool, int, float)) for v in items) and len({type(v) for v in items}) <= 1:
            return list(items)
        return [str(v) for v in items]
    return str(value)


class Span:
    """A span: ``set_attribute``, ``set_attributes``, ``add_event``, ``record_exception``, ``set_status``, ``end``.

    Never raises from telemetry code: when tracing is off or the span was not
    sampled every method is a no-op. Attribute values are redacted.
    """

    def __init__(
        self,
        telemetry: "Telemetry",
        name: str,
        kind: str,
        context: SpanContext,
        parent_span_id: str | None,
        recording: bool,
        attributes: Mapping[str, Any] | None = None,
        otel_span: Any = None,
    ) -> None:
        self._telemetry = telemetry
        self.name = name
        self.kind = kind
        self.context = context
        self.parent_span_id = parent_span_id
        self._recording = recording
        self._otel = otel_span
        self.attributes: dict[str, Any] = {}
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.status = "unset"
        self.status_message: str | None = None
        self.duration_ms: float | None = None
        self._start = time.perf_counter()
        self._ended = False
        if attributes:
            self.set_attributes(attributes)

    @property
    def trace_id(self) -> str:
        return self.context.trace_id

    @property
    def span_id(self) -> str:
        return self.context.span_id

    @property
    def is_recording(self) -> bool:
        return self._recording and not self._ended

    def set_attribute(self, key: str, value: Any) -> "Span":
        if not self.is_recording:
            return self
        value = _attribute(value)
        if value is None:
            return self
        value = redact_value(key, value)
        self.attributes[key] = value
        if self._otel is not None:
            self._otel.set_attribute(key, value)
        return self

    def set_attributes(self, attributes: Mapping[str, Any]) -> "Span":
        for key, value in attributes.items():
            self.set_attribute(str(key), value)
        return self

    def add_event(self, name: str, attributes: Mapping[str, Any] | None = None) -> "Span":
        if not self.is_recording:
            return self
        clean = {str(k): redact_value(str(k), _attribute(v)) for k, v in (attributes or {}).items() if v is not None}
        self.events.append((name, clean))
        if self._otel is not None:
            self._otel.add_event(name, clean)
        return self

    def record_exception(self, exc: BaseException) -> "Span":
        """Add an ``exception`` event (type, message, stack trace), redacted."""
        return self.add_event(
            "exception",
            {
                "exception.type": type(exc).__qualname__,
                "exception.message": redact_text(str(exc)),
                "exception.stacktrace": redact_text("".join(traceback.format_exception(type(exc), exc, exc.__traceback__))),
            },
        )

    def set_status(self, status: str, description: str | None = None) -> "Span":
        """``"ok"``, ``"error"`` (with an optional description) or ``"unset"``."""
        if not self.is_recording or status not in ("ok", "error", "unset"):
            return self
        self.status = status
        self.status_message = redact_text(description) if description and status == "error" else None
        if self._otel is not None:
            from opentelemetry.trace import Status, StatusCode

            code = {"ok": StatusCode.OK, "error": StatusCode.ERROR, "unset": StatusCode.UNSET}[status]
            self._otel.set_status(Status(code, self.status_message))
        return self

    def end(self) -> None:
        if self._ended:
            return
        recording = self.is_recording
        self._ended = True
        self.duration_ms = (time.perf_counter() - self._start) * 1000
        if self._otel is not None:
            self._otel.end()  # the log span processor writes the span.end line
            return
        if recording and self._telemetry.log_spans:
            emit_span_end(
                self._telemetry.service_name,
                self.name,
                self.kind,
                self.trace_id,
                self.span_id,
                self.parent_span_id,
                self.duration_ms,
                (self.status_message or "error") if self.status == "error" else None,
                self.attributes,
            )

    def traceparent(self) -> str | None:
        """The ``traceparent`` header for a call made under this span (``None`` without a trace)."""
        if not self.context.is_valid:
            return None
        return format_traceparent(self.trace_id, self.span_id, self.context.sampled)

    def inject(self, headers: dict[str, str]) -> dict[str, str]:
        """Add ``traceparent`` / ``tracestate`` / ``baggage`` to ``headers`` unless already present."""
        present = {k.lower() for k in headers}
        values = {"traceparent": self.traceparent(), "tracestate": self.context.tracestate, "baggage": self.context.baggage}
        for key, value in values.items():
            if value and key not in present:
                headers[key] = value
        return headers

    def __repr__(self) -> str:
        return f"<Span {self.name!r} trace={self.trace_id or '-'} span={self.span_id or '-'}>"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _flag(value: str | None, default: bool) -> bool:
    text = (value or "").strip().lower()
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    return default


def parse_resource_attributes(value: str | None) -> dict[str, str]:
    """``OTEL_RESOURCE_ATTRIBUTES``: ``key=value,key2=value2`` (percent-encoded values)."""
    out: dict[str, str] = {}
    for part in (value or "").split(","):
        key, sep, raw = part.partition("=")
        if sep and key.strip():
            out[key.strip()] = urllib.parse.unquote(raw.strip())
    return out


class _Sampler:
    """``OTEL_TRACES_SAMPLER``: always_on, always_off, traceidratio and their parentbased_ variants."""

    def __init__(self, name: str | None, arg: str | None) -> None:
        name = (name or "parentbased_always_on").strip().lower()
        self.parent_based = name.startswith("parentbased_")
        root = name[len("parentbased_"):] if self.parent_based else name
        if root == "always_on":
            self.ratio = 1.0
        elif root == "always_off":
            self.ratio = 0.0
        elif root == "traceidratio":
            try:
                self.ratio = min(1.0, max(0.0, float(arg))) if arg else 1.0
            except ValueError:
                log.warning("OTEL_TRACES_SAMPLER_ARG=%r is not a number; sampling everything", arg)
                self.ratio = 1.0
        else:
            log.warning("unsupported OTEL_TRACES_SAMPLER=%r; using parentbased_always_on", name)
            self.parent_based, self.ratio = True, 1.0

    def should_sample(self, parent: SpanContext | None, trace_id: str) -> bool:
        if parent is not None and self.parent_based:
            return parent.sampled
        if self.ratio >= 1.0:
            return True
        if self.ratio <= 0.0:
            return False
        return int(trace_id[16:], 16) < self.ratio * (1 << 64)


_CURRENT: Any = object()  # start_span(parent=...) default: the active span


class Telemetry:
    """Spans, metrics and log settings for one plugin, read from the environment.

    ``use_otel``: ``None`` = use OpenTelemetry when importable, ``False`` =
    built-in mode, ``True`` = require it. ``env`` defaults to ``os.environ``.
    """

    _noop: "Telemetry | None" = None

    def __init__(
        self,
        plugin_id: str,
        plugin_version: str = "",
        *,
        env: Mapping[str, str] | None = None,
        use_otel: bool | None = None,
    ) -> None:
        env = dict(os.environ if env is None else env)
        self.env = env
        self.plugin_id = plugin_id
        self.enabled = not _flag(env.get("OTEL_SDK_DISABLED"), False)
        self.log_spans = self.enabled and _flag(env.get("LANDFLOW_LOG_SPANS"), True)
        self.prometheus = _flag(env.get("LANDFLOW_METRICS_PROMETHEUS"), True)
        from_env = parse_resource_attributes(env.get("OTEL_RESOURCE_ATTRIBUTES"))
        self.service_name = (
            (env.get("OTEL_SERVICE_NAME") or "").strip() or from_env.get("service.name") or f"landflow-plugin-{plugin_id}"
        )
        self.resource: dict[str, Any] = {
            "service.name": self.service_name,
            "service.version": plugin_version,
            "service.namespace": "landflow",
            "landflow.plugin.id": plugin_id,
            "landflow.plugin.language": "python",
            **from_env,
        }
        self.resource["service.name"] = self.service_name
        self._sampler = _Sampler(env.get("OTEL_TRACES_SAMPLER"), env.get("OTEL_TRACES_SAMPLER_ARG"))
        self.otel = False
        self._tracer: Any = None
        self._tracer_provider: Any = None
        self._meter_provider: Any = None
        meter = None
        if self.enabled and use_otel is not False:
            try:
                meter = self._setup_otel()
            except ImportError as exc:
                if use_otel:
                    raise
                log.debug("opentelemetry not installed (%s); using built-in tracing", exc)
            except Exception as exc:  # noqa: BLE001 - a broken exporter config must not stop the plugin
                log.warning("OpenTelemetry setup failed (%s: %s); using built-in tracing", type(exc).__name__, exc)
                self.otel, self._tracer = False, None
        if not self.otel:
            self.resource.update({"telemetry.sdk.name": SDK_NAME, "telemetry.sdk.language": "python", "telemetry.sdk.version": __version__})
        self.metrics = MetricsRegistry(enabled=self.enabled, meter=meter)
        # Automatic plugin metrics (docs/observability.md §5, "Plugins").
        self.executions = self.metrics.counter("landflow.plugin.executions", "{execution}", "Node executions served by this plugin")
        self.execute_duration = self.metrics.histogram("landflow.plugin.execute.duration", "ms", "Duration of node executions")
        self.items = self.metrics.counter("landflow.plugin.items", "{item}", "Items received (in) and emitted (out) by node executions")
        self.load_options_calls = self.metrics.counter("landflow.plugin.load_options", "{call}", "LoadOptions calls")
        self.in_flight = self.metrics.gauge("landflow.plugin.inflight", "{call}", "Calls running in the plugin right now")
        self.http_client_duration = self.metrics.histogram(
            "http.client.request.duration", "s", "Duration of outbound HTTP requests made through ctx.http"
        )

    @classmethod
    def noop(cls) -> "Telemetry":
        """A disabled instance for contexts built without a plugin (e.g. in unit tests)."""
        if cls._noop is None:
            cls._noop = cls("unknown", env={"OTEL_SDK_DISABLED": "true"}, use_otel=False)
        return cls._noop

    # ----------------------------------------------------------------- otel

    def _setup_otel(self) -> Any:
        global _otel_trace
        from opentelemetry import metrics as ot_metrics
        from opentelemetry import trace as ot_trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider, sampling

        resource = Resource.create(self.resource)
        if self._sampler.ratio >= 1.0:
            root: Any = sampling.ALWAYS_ON
        elif self._sampler.ratio <= 0.0:
            root = sampling.ALWAYS_OFF
        else:
            root = sampling.TraceIdRatioBased(self._sampler.ratio)
        provider = TracerProvider(resource=resource, sampler=sampling.ParentBased(root) if self._sampler.parent_based else root)
        provider.add_span_processor(_log_span_processor(self))
        exporter = self._exporter("TRACES")
        if exporter is not None:
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            provider.add_span_processor(BatchSpanProcessor(exporter))
        if isinstance(ot_trace.get_tracer_provider(), ot_trace.ProxyTracerProvider):
            ot_trace.set_tracer_provider(provider)  # let third-party instrumentation join our traces
        self._tracer_provider = provider
        self._tracer = provider.get_tracer("landflow_sdk", __version__)
        _otel_trace = ot_trace

        meter = None
        metric_exporter = self._exporter("METRICS")
        if metric_exporter is not None:
            from opentelemetry.sdk.metrics import MeterProvider
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

            try:
                interval = int(self.env.get("OTEL_METRIC_EXPORT_INTERVAL") or 15000)
            except ValueError:
                interval = 15000
            reader = PeriodicExportingMetricReader(metric_exporter, export_interval_millis=interval)
            self._meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
            if type(ot_metrics.get_meter_provider()).__name__ == "_ProxyMeterProvider":
                ot_metrics.set_meter_provider(self._meter_provider)
            meter = self._meter_provider.get_meter("landflow_sdk", __version__)
        self.resource = dict(resource.attributes)
        self.otel = True
        return meter

    def _exporter(self, signal: str) -> Any:
        """An OTLP exporter for ``TRACES`` / ``METRICS`` when an endpoint is configured, else ``None``."""
        specific = (self.env.get(f"OTEL_EXPORTER_OTLP_{signal}_ENDPOINT") or "").strip()
        base = (self.env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
        if not specific and not base:
            return None
        protocol = (
            self.env.get(f"OTEL_EXPORTER_OTLP_{signal}_PROTOCOL") or self.env.get("OTEL_EXPORTER_OTLP_PROTOCOL") or "http/protobuf"
        ).strip()
        module = "trace_exporter" if signal == "TRACES" else "metric_exporter"
        cls_name = "OTLPSpanExporter" if signal == "TRACES" else "OTLPMetricExporter"
        if protocol == "grpc":
            try:
                mod = __import__(f"opentelemetry.exporter.otlp.proto.grpc.{module}", fromlist=[cls_name])
                return getattr(mod, cls_name)(endpoint=specific or base)
            except ImportError:
                log.warning("OTLP protocol grpc needs opentelemetry-exporter-otlp-proto-grpc; using http/protobuf")
        elif protocol != "http/protobuf":
            log.warning("unsupported OTLP protocol %r; using http/protobuf", protocol)
        endpoint = specific or base.rstrip("/") + ("/v1/traces" if signal == "TRACES" else "/v1/metrics")
        try:
            mod = __import__(f"opentelemetry.exporter.otlp.proto.http.{module}", fromlist=[cls_name])
        except ImportError:
            log.warning("OTLP export needs opentelemetry-exporter-otlp-proto-http (pip install 'landflow-sdk[otel]')")
            return None
        return getattr(mod, cls_name)(endpoint=endpoint)

    def flush(self, timeout_ms: int = 5000) -> None:
        """Export pending spans and metrics (called when the server stops)."""
        for provider in (self._tracer_provider, self._meter_provider):
            if provider is not None:
                try:
                    provider.force_flush(timeout_ms)
                except Exception:  # noqa: BLE001
                    log.debug("flush failed", exc_info=True)

    def shutdown(self) -> None:
        for provider in (self._tracer_provider, self._meter_provider):
            if provider is not None:
                try:
                    provider.shutdown()
                except Exception:  # noqa: BLE001
                    log.debug("shutdown failed", exc_info=True)

    # ---------------------------------------------------------------- spans

    def extract(self, headers: Any) -> SpanContext | None:
        return extract(headers)

    def start_span(
        self,
        name: str,
        *,
        kind: str = "internal",
        attributes: Mapping[str, Any] | None = None,
        parent: Any = _CURRENT,
    ) -> Span:
        """Start (but do not activate) a span. ``parent``: a ``Span``, a ``SpanContext``,
        ``None`` for a new trace, or by default the active span."""
        kind = kind if kind in SPAN_KINDS else "internal"
        use_current = parent is _CURRENT
        if use_current:
            parent = _current_span.get()
        parent_ctx: SpanContext | None = parent.context if isinstance(parent, Span) else parent
        if parent_ctx is not None and not parent_ctx.is_valid:
            parent_ctx = None
        if not self.enabled:
            return Span(self, name, kind, parent_ctx or _EMPTY_CONTEXT, None, recording=False)
        if self._tracer is not None:
            return self._start_otel(name, kind, attributes, parent, parent_ctx, use_current)
        trace_id = parent_ctx.trace_id if parent_ctx else _new_trace_id()
        sampled = self._sampler.should_sample(parent_ctx, trace_id)
        context = SpanContext(
            trace_id,
            _new_span_id(),
            sampled,
            parent_ctx.tracestate if parent_ctx else "",
            parent_ctx.baggage if parent_ctx else "",
        )
        return Span(self, name, kind, context, parent_ctx.span_id if parent_ctx else None, sampled, attributes)

    def _start_otel(self, name: str, kind: str, attributes: Any, parent: Any, parent_ctx: SpanContext | None, use_current: bool) -> Span:
        from opentelemetry import context as ot_context
        from opentelemetry import trace as ot_trace
        from opentelemetry.trace.span import TraceState

        parent_span_id = parent_ctx.span_id if parent_ctx else None
        if isinstance(parent, Span) and parent._otel is not None:
            otel_parent: Any = ot_trace.set_span_in_context(parent._otel)
        elif parent_ctx is not None:
            remote = ot_trace.SpanContext(
                int(parent_ctx.trace_id, 16),
                int(parent_ctx.span_id, 16),
                is_remote=parent_ctx.remote,
                trace_flags=ot_trace.TraceFlags(0x01 if parent_ctx.sampled else 0x00),
                trace_state=TraceState.from_header([parent_ctx.tracestate]) if parent_ctx.tracestate else None,
            )
            otel_parent = ot_trace.set_span_in_context(ot_trace.NonRecordingSpan(remote))
        elif use_current:
            otel_parent = None  # whatever OTel span is active (third-party instrumentation), else a root
            active = ot_trace.get_current_span().get_span_context()
            parent_span_id = f"{active.span_id:016x}" if active.is_valid else None
        else:
            otel_parent = ot_context.Context()  # explicitly a new trace
        otel_kind = getattr(ot_trace.SpanKind, kind.upper())
        otel_span = self._tracer.start_span(name, context=otel_parent, kind=otel_kind)
        sc = otel_span.get_span_context()
        context = SpanContext(
            f"{sc.trace_id:032x}",
            f"{sc.span_id:016x}",
            bool(sc.trace_flags & 0x01),
            sc.trace_state.to_header() if sc.trace_state else "",
            parent_ctx.baggage if parent_ctx else "",
        )
        return Span(self, name, kind, context, parent_span_id, otel_span.is_recording(), attributes, otel_span=otel_span)

    @contextmanager
    def use_span(self, span: Span) -> Iterator[Span]:
        """Make ``span`` the active span (log lines, child spans, ``ctx.http``) without ending it."""
        token = _current_span.set(span)
        otel_token = None
        if span._otel is not None:
            from opentelemetry import context as ot_context
            from opentelemetry import trace as ot_trace

            otel_token = ot_context.attach(ot_trace.set_span_in_context(span._otel))
        try:
            yield span
        finally:
            if otel_token is not None:
                from opentelemetry import context as ot_context

                ot_context.detach(otel_token)
            _current_span.reset(token)

    @contextmanager
    def span(self, name: str, attributes: Mapping[str, Any] | None = None, *, kind: str = "internal") -> Iterator[Span]:
        """``with telemetry.span("x", {...}) as span:``: a child of the active span. An exception
        leaving the block is recorded on the span (error status) and re-raised."""
        span = self.start_span(name, kind=kind, attributes=attributes)
        with self.use_span(span):
            try:
                yield span
            except Exception as exc:
                span.record_exception(exc)
                span.set_status("error", str(exc) or type(exc).__name__)
                raise
            finally:
                span.end()

    # -------------------------------------------------------------- metrics

    def render_prometheus(self) -> str:
        return self.metrics.render_prometheus(self.resource)


def _log_span_processor(telemetry: Telemetry) -> Any:
    """An OTel ``SpanProcessor`` that writes the ``span.end`` line for every finished span."""
    from opentelemetry.sdk.trace import SpanProcessor
    from opentelemetry.trace import StatusCode

    class LogSpanProcessor(SpanProcessor):
        def on_end(self, span: Any) -> None:
            if not telemetry.log_spans:
                return
            error = None
            if span.status.status_code == StatusCode.ERROR:
                error = span.status.description or "error"
            parent = span.parent
            duration = ((span.end_time or 0) - (span.start_time or 0)) / 1e6
            attributes = {k: redact_value(k, v) for k, v in (span.attributes or {}).items()}
            emit_span_end(
                telemetry.service_name,
                span.name,
                span.kind.name.lower(),
                f"{span.context.trace_id:032x}",
                f"{span.context.span_id:016x}",
                f"{parent.span_id:016x}" if parent is not None else None,
                duration,
                redact_text(error) if error else None,
                attributes,
            )

    return LogSpanProcessor()
