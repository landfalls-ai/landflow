"""In-memory metrics with a Prometheus text renderer (docs/observability.md §5).

Every instrument keeps its own series, which back ``GET /metrics`` whether or
not OpenTelemetry is installed. When an OTel meter is attached (the ``otel``
extra plus an OTLP endpoint) each recording is mirrored to it for export.

Cardinality guard: attribute values are truncated to 100 characters and each
instrument keeps at most 1000 attribute sets; further sets fold into one
series marked ``otel.metric.overflow=true``.
"""

from __future__ import annotations

import logging
import math
import re
import threading
from typing import Any, Mapping, Sequence

log = logging.getLogger("landflow_sdk.metrics")

NAME_RE = re.compile(r"^[a-z][a-z0-9_.]{0,100}$")
DURATION_BUCKETS_MS: tuple[float, ...] = (1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000)
# OTel semantic-convention advisory buckets for `http.client.request.duration` (seconds).
DURATION_BUCKETS_S: tuple[float, ...] = (0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10)
MAX_ATTRIBUTE_SETS = 1000
MAX_VALUE_LENGTH = 100
OVERFLOW_KEY: tuple[tuple[str, Any], ...] = (("otel.metric.overflow", True),)

_UNIT_SUFFIXES = {
    "ms": "milliseconds", "s": "seconds", "min": "minutes", "h": "hours", "d": "days",
    "us": "microseconds", "ns": "nanoseconds", "By": "bytes", "KiBy": "kibibytes", "MiBy": "mebibytes",
    "kBy": "kilobytes", "KBy": "kilobytes", "MBy": "megabytes", "GBy": "gigabytes", "%": "percent",
}
_PROM_INVALID = re.compile(r"[^a-zA-Z0-9_:]")
_LABEL_INVALID = re.compile(r"[^a-zA-Z0-9_]")

AttributeKey = tuple[tuple[str, Any], ...]


def validate_name(name: Any) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ValueError(f"metric name {name!r} must match {NAME_RE.pattern} (e.g. 'telegram.messages.sent')")
    return name


def _clean_value(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if not isinstance(value, float) or math.isfinite(value) else str(value)
    text = value if isinstance(value, str) else str(value)
    return text[:MAX_VALUE_LENGTH]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


class _Instrument:
    kind = ""

    def __init__(self, registry: "MetricsRegistry", name: str, unit: str, description: str) -> None:
        self.registry = registry
        self.name = name
        self.unit = unit
        self.description = description
        self._series: dict[AttributeKey, Any] = {}
        self._lock = threading.Lock()
        self._otel: Any = None

    def _key(self, attributes: Mapping[str, Any] | None) -> AttributeKey:
        if not attributes:
            key: AttributeKey = ()
        else:
            key = tuple(sorted((str(k), _clean_value(v)) for k, v in attributes.items() if v is not None))
        if key not in self._series and len(self._series) >= MAX_ATTRIBUTE_SETS:
            return OVERFLOW_KEY
        return key

    def _mirror(self, method: str, value: float, key: AttributeKey) -> None:
        if self._otel is not None:
            try:
                getattr(self._otel, method)(value, attributes=dict(key))
            except Exception:  # noqa: BLE001 - exporting must never break a node
                log.debug("otel %s %s failed", method, self.name, exc_info=True)

    def snapshot(self) -> list[tuple[AttributeKey, Any]]:
        with self._lock:
            return [(key, list(v) if isinstance(v, list) else v) for key, v in self._series.items()]


class Counter(_Instrument):
    """Monotonic sum: ``add(value=1, attributes=None)``."""

    kind = "counter"

    def add(self, value: float = 1, attributes: Mapping[str, Any] | None = None) -> None:
        number = _number(value)
        if not self.registry.enabled or number is None or number < 0:
            if number is not None and number < 0:
                log.debug("counter %s: negative increment %r ignored", self.name, value)
            return
        with self._lock:
            key = self._key(attributes)
            self._series[key] = self._series.get(key, 0.0) + number
        self._mirror("add", value, key)


class Histogram(_Instrument):
    """Distribution: ``record(value, attributes=None)``."""

    kind = "histogram"

    def __init__(self, registry: "MetricsRegistry", name: str, unit: str, description: str, buckets: Sequence[float] | None) -> None:
        super().__init__(registry, name, unit, description)
        if buckets is None:
            buckets = DURATION_BUCKETS_S if unit == "s" else DURATION_BUCKETS_MS
        self.buckets = tuple(sorted(float(b) for b in buckets))

    def record(self, value: float, attributes: Mapping[str, Any] | None = None) -> None:
        number = _number(value)
        if not self.registry.enabled or number is None:
            return
        with self._lock:
            key = self._key(attributes)
            series = self._series.get(key)
            if series is None:
                series = self._series[key] = [[0] * len(self.buckets), 0.0, 0]  # bucket counts, sum, count
            for i, bound in enumerate(self.buckets):
                if number <= bound:
                    series[0][i] += 1
                    break
            series[1] += number
            series[2] += 1
        self._mirror("record", value, key)


class Gauge(_Instrument):
    """Last value: ``set(value, attributes=None)``."""

    kind = "gauge"

    def set(self, value: float, attributes: Mapping[str, Any] | None = None) -> None:
        number = _number(value)
        if not self.registry.enabled or number is None:
            return
        with self._lock:
            key = self._key(attributes)
            self._series[key] = number
        self._mirror("set", value, key)


class MetricsRegistry:
    """Owns every instrument of one plugin. Instruments are cached by name."""

    def __init__(self, enabled: bool = True, meter: Any = None) -> None:
        self.enabled = enabled
        self.meter = meter
        self._instruments: dict[str, _Instrument] = {}
        self._lock = threading.Lock()

    def _get(self, cls: type[_Instrument], name: str, unit: str, description: str, **extra: Any) -> Any:
        validate_name(name)
        with self._lock:
            existing = self._instruments.get(name)
            if existing is not None:
                if not isinstance(existing, cls):
                    raise ValueError(f"metric {name!r} is already registered as a {existing.kind}")
                return existing
            instrument = cls(self, name, unit or "", description or "", **extra)
            if self.meter is not None and self.enabled:
                instrument._otel = _otel_instrument(self.meter, instrument)
            self._instruments[name] = instrument
            return instrument

    def counter(self, name: str, unit: str = "", description: str = "") -> Counter:
        return self._get(Counter, name, unit, description)

    def histogram(self, name: str, unit: str = "", description: str = "", buckets: Sequence[float] | None = None) -> Histogram:
        return self._get(Histogram, name, unit, description, buckets=buckets)

    def gauge(self, name: str, unit: str = "", description: str = "") -> Gauge:
        return self._get(Gauge, name, unit, description)

    def instruments(self) -> list[_Instrument]:
        with self._lock:
            return sorted(self._instruments.values(), key=lambda i: i.name)

    def render_prometheus(self, resource: Mapping[str, Any] | None = None) -> str:
        """Prometheus text exposition (format 0.0.4)."""
        if not self.enabled:
            return ""
        lines: list[str] = []
        if resource:
            lines += ["# HELP target_info Target metadata", "# TYPE target_info gauge", f"target_info{_labels(tuple(resource.items()))} 1"]
        for instrument in self.instruments():
            series = instrument.snapshot()
            if not series:
                continue
            name = prometheus_name(instrument.name, instrument.unit, instrument.kind)
            if instrument.description:
                lines.append(f"# HELP {name} {_escape_help(instrument.description)}")
            lines.append(f"# TYPE {name} {instrument.kind}")
            for key, value in series:
                if isinstance(instrument, Histogram):
                    counts, total, count = value
                    cumulative = 0
                    for bound, n in zip(instrument.buckets, counts):
                        cumulative += n
                        lines.append(f"{name}_bucket{_labels(key + (('le', _fmt(bound)),))} {cumulative}")
                    lines.append(f"{name}_bucket{_labels(key + (('le', '+Inf'),))} {count}")
                    lines.append(f"{name}_sum{_labels(key)} {_fmt(total)}")
                    lines.append(f"{name}_count{_labels(key)} {count}")
                else:
                    lines.append(f"{name}{_labels(key)} {_fmt(value)}")
        return "\n".join(lines) + "\n" if lines else ""


def prometheus_name(name: str, unit: str, kind: str) -> str:
    """``landflow.plugin.execute.duration`` + ``ms`` -> ``landflow_plugin_execute_duration_milliseconds``."""
    base = _PROM_INVALID.sub("_", name)
    unit = unit or ""
    suffix = "" if (unit in ("1", "") or unit.startswith("{")) else _UNIT_SUFFIXES.get(unit, _PROM_INVALID.sub("_", unit.replace("/", "_per_")))
    if suffix and not base.endswith("_" + suffix):
        base += "_" + suffix
    if kind == "counter" and not base.endswith("_total"):
        base += "_total"
    return "_" + base if base[:1].isdigit() else base


def _fmt(value: float) -> str:
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(value)


def _escape_label(value: Any) -> str:
    text = ("true" if value else "false") if isinstance(value, bool) else str(value)
    return text.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _escape_help(text: str) -> str:
    return text.replace("\\", "\\\\").replace("\n", "\\n")


def _labels(key: Sequence[tuple[str, Any]]) -> str:
    if not key:
        return ""
    parts = []
    for k, v in key:
        label = _LABEL_INVALID.sub("_", k)
        if label[:1].isdigit():
            label = "_" + label
        parts.append(f'{label}="{_escape_label(v)}"')
    return "{" + ",".join(parts) + "}"


def _otel_instrument(meter: Any, instrument: _Instrument) -> Any:
    try:
        if isinstance(instrument, Counter):
            return meter.create_counter(instrument.name, unit=instrument.unit, description=instrument.description)
        if isinstance(instrument, Histogram):
            try:
                return meter.create_histogram(
                    instrument.name, unit=instrument.unit, description=instrument.description,
                    explicit_bucket_boundaries_advisory=list(instrument.buckets),
                )
            except TypeError:  # opentelemetry-api < 1.23
                return meter.create_histogram(instrument.name, unit=instrument.unit, description=instrument.description)
        create_gauge = getattr(meter, "create_gauge", None)
        if create_gauge is not None:
            return create_gauge(instrument.name, unit=instrument.unit, description=instrument.description)
    except Exception:  # noqa: BLE001
        log.debug("cannot create otel instrument %s", instrument.name, exc_info=True)
    return None


# ---------------------------------------------------------------------------
# ctx.metrics: instruments that add the context's attributes
# ---------------------------------------------------------------------------


class _Bound:
    def __init__(self, instrument: _Instrument, attributes: Mapping[str, Any]) -> None:
        self.instrument = instrument
        self._attributes = dict(attributes)

    def _merge(self, attributes: Mapping[str, Any] | None) -> dict[str, Any]:
        return {**(attributes or {}), **self._attributes}

    @property
    def name(self) -> str:
        return self.instrument.name


class BoundCounter(_Bound):
    def add(self, value: float = 1, attributes: Mapping[str, Any] | None = None) -> None:
        self.instrument.add(value, self._merge(attributes))  # type: ignore[attr-defined]


class BoundHistogram(_Bound):
    def record(self, value: float, attributes: Mapping[str, Any] | None = None) -> None:
        self.instrument.record(value, self._merge(attributes))  # type: ignore[attr-defined]


class BoundGauge(_Bound):
    def set(self, value: float, attributes: Mapping[str, Any] | None = None) -> None:
        self.instrument.set(value, self._merge(attributes))  # type: ignore[attr-defined]


class Metrics:
    """``ctx.metrics``: ``counter(name).add(v, attrs)``, ``histogram(name).record(v, attrs)``, ``gauge(name).set(v, attrs)``.

    Adds ``landflow.plugin.id``, ``landflow.node.type`` and ``landflow.workflow.id``
    (when known) to every recording. Names must match ``^[a-z][a-z0-9_.]{0,100}$``.
    """

    def __init__(self, registry: MetricsRegistry, attributes: Mapping[str, Any] | None = None) -> None:
        self.registry = registry
        self.attributes = {k: v for k, v in (attributes or {}).items() if v not in (None, "")}

    def counter(self, name: str, unit: str = "", description: str = "") -> BoundCounter:
        return BoundCounter(self.registry.counter(name, unit, description), self.attributes)

    def histogram(self, name: str, unit: str = "", description: str = "", buckets: Sequence[float] | None = None) -> BoundHistogram:
        return BoundHistogram(self.registry.histogram(name, unit, description, buckets), self.attributes)

    def gauge(self, name: str, unit: str = "", description: str = "") -> BoundGauge:
        return BoundGauge(self.registry.gauge(name, unit, description), self.attributes)
