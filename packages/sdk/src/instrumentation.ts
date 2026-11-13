/**
 * The node-author telemetry API (docs/observability.md §6): `ctx.span`,
 * `ctx.metrics.*` and the traced `ctx.http`. Everything degrades to no-ops
 * when telemetry is disabled; nothing here throws because of telemetry.
 */
import { context, SpanKind, SpanStatusCode, trace, type Attributes, type AttributeValue, type Context, type Span } from '@opentelemetry/api';
import { DURATION_BUCKETS_MS, injectHeaders, type Telemetry } from './otel';
import { redactAttributes, scrub } from './redact';

export type { Attributes, Span };

export type SpanCallback<T> = (span: Span) => Promise<T> | T;

export interface SpanOptions {
  /** Default `internal`. Use `client` for a call to another service over a protocol `ctx.http` doesn't cover (SMTP, a database driver). */
  kind?: 'internal' | 'client' | 'producer' | 'consumer';
}

export interface SpanFunction {
  <T>(name: string, attributes: Attributes, fn: SpanCallback<T>, options?: SpanOptions): Promise<T>;
  <T>(name: string, fn: SpanCallback<T>): Promise<T>;
}

const SPAN_KINDS = { internal: SpanKind.INTERNAL, client: SpanKind.CLIENT, producer: SpanKind.PRODUCER, consumer: SpanKind.CONSUMER };

/** Attribute values allowed on metrics. */
export type MetricAttributes = Record<string, string | number | boolean | undefined>;

export interface MetricOptions {
  description?: string;
  /** UCUM unit, e.g. `ms`, `s`, `By`, `{message}`. */
  unit?: string;
}

export interface HistogramOptions extends MetricOptions {
  /** Explicit bucket boundaries. Default for `unit: 'ms'`: the Landflow duration buckets. */
  buckets?: number[];
}

export interface NodeCounter {
  add(value: number, attributes?: MetricAttributes): void;
}
export interface NodeHistogram {
  record(value: number, attributes?: MetricAttributes): void;
}
export interface NodeGauge {
  set(value: number, attributes?: MetricAttributes): void;
}

export interface NodeMetrics {
  counter(name: string, options?: MetricOptions): NodeCounter;
  histogram(name: string, options?: HistogramOptions): NodeHistogram;
  gauge(name: string, options?: MetricOptions): NodeGauge;
}

/** A fetch that opens an `HTTP {METHOD}` client span and sends `traceparent`. */
export type TracedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const METRIC_NAME = /^[a-z][a-z0-9_.]{0,100}$/;
export const MAX_ATTRIBUTE_LENGTH = 100;
export const MAX_ATTRIBUTE_SETS = 1000;

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

/** The parent for a new span: the active span, else the call's base context (server span). */
function parentContext(base: Context): Context {
  const active = context.active();
  return trace.getSpan(active) ? active : base;
}

export function createSpanFunction(telemetry: Telemetry, base: Context = context.active()): SpanFunction {
  return (async <T>(name: string, attributesOrFn: Attributes | SpanCallback<T>, maybeFn?: SpanCallback<T>, options?: SpanOptions): Promise<T> => {
    const fn = (typeof attributesOrFn === 'function' ? attributesOrFn : maybeFn) as SpanCallback<T>;
    const attributes = typeof attributesOrFn === 'function' ? {} : attributesOrFn;
    if (typeof fn !== 'function') throw new TypeError('ctx.span(name, attributes?, fn): fn must be a function');
    const parent = parentContext(base);
    const kind = SPAN_KINDS[options?.kind ?? 'internal'] ?? SpanKind.INTERNAL;
    const span = telemetry.tracer.startSpan(name, { kind, attributes: redactAttributes(attributes ?? {}) }, parent);
    try {
      return await context.with(trace.setSpan(parent, span), () => fn(span));
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: scrub((error as Error)?.message ?? String(error)) });
      throw error;
    } finally {
      span.end();
    }
  }) as SpanFunction;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type Recorder = (value: number, attributes: Attributes) => void;

interface CachedInstrument {
  record: Recorder;
  /** Attribute sets seen so far (cardinality guard). */
  sets: Set<string>;
}

const instrumentCache = new WeakMap<object, Map<string, CachedInstrument>>();

function instrument(telemetry: Telemetry, kind: 'counter' | 'histogram' | 'gauge', name: string, options: HistogramOptions = {}): CachedInstrument {
  if (!METRIC_NAME.test(name)) {
    throw new Error(`Invalid metric name "${name}": use lower-case letters, digits, "_" and "." (${METRIC_NAME}), e.g. "telegram.messages.sent"`);
  }
  let cache = instrumentCache.get(telemetry.customMeter);
  if (!cache) instrumentCache.set(telemetry.customMeter, (cache = new Map()));
  const key = `${kind}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const meter = telemetry.customMeter;
  const base = { ...(options.description && { description: options.description }), ...(options.unit && { unit: options.unit }) };
  let record: Recorder;
  if (kind === 'counter') {
    const counter = meter.createCounter(name, base);
    record = (v, a) => counter.add(v, a);
  } else if (kind === 'histogram') {
    const buckets = options.buckets ?? (options.unit === 'ms' ? DURATION_BUCKETS_MS : undefined);
    const histogram = meter.createHistogram(name, { ...base, ...(buckets && { advice: { explicitBucketBoundaries: buckets } }) });
    record = (v, a) => histogram.record(v, a);
  } else {
    const gauge = meter.createGauge(name, base);
    record = (v, a) => gauge.record(v, a);
  }
  const created = { record, sets: new Set<string>() };
  cache.set(key, created);
  return created;
}

/** Truncate values to 100 characters, then fold attribute sets past the 1000th into `otel.metric.overflow=true`. */
function guard(entry: CachedInstrument, attributes: Attributes): Attributes {
  const clean: Attributes = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (value === undefined || value === null) continue;
    clean[key] = typeof value === 'string' && value.length > MAX_ATTRIBUTE_LENGTH ? value.slice(0, MAX_ATTRIBUTE_LENGTH) : (value as AttributeValue);
  }
  const id = JSON.stringify(clean);
  if (entry.sets.has(id)) return clean;
  if (entry.sets.size >= MAX_ATTRIBUTE_SETS) return { 'otel.metric.overflow': true };
  entry.sets.add(id);
  return clean;
}

/**
 * `ctx.metrics`: instruments on the custom meter with `landflow.plugin.id`,
 * `landflow.node.type` and `landflow.workflow.id` added to every measurement.
 */
export function createNodeMetrics(telemetry: Telemetry, auto: MetricAttributes): NodeMetrics {
  const measure = (entry: CachedInstrument, value: number, attributes?: MetricAttributes) => {
    if (!telemetry.enabled || typeof value !== 'number' || Number.isNaN(value)) return;
    try {
      entry.record(value, guard(entry, { ...(attributes as Attributes), ...(auto as Attributes) }));
    } catch {
      // Never fail a node because of a metric.
    }
  };
  return {
    counter(name, options) {
      const entry = instrument(telemetry, 'counter', name, options);
      return { add: (value, attributes) => measure(entry, value, attributes) };
    },
    histogram(name, options) {
      const entry = instrument(telemetry, 'histogram', name, options);
      return { record: (value, attributes) => measure(entry, value, attributes) };
    },
    gauge(name, options) {
      const entry = instrument(telemetry, 'gauge', name, options);
      return { set: (value, attributes) => measure(entry, value, attributes) };
    },
  };
}

// ---------------------------------------------------------------------------
// Traced HTTP
// ---------------------------------------------------------------------------

/** `url.full` without query string, fragment or user info, with secrets scrubbed. */
export function sanitizeUrl(url: URL): string {
  return scrub(`${url.protocol}//${url.host}${url.pathname}`);
}

export function createTracedFetch(telemetry: Telemetry, options: { base?: Context; signal?: AbortSignal; fetch?: typeof fetch } = {}): TracedFetch {
  // The host injects a guarded fetch (its outbound policy) for in-process nodes; remote plugins use the global one.
  const send = options.fetch ?? fetch;
  const base = options.base ?? context.active();
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const attributes: Attributes = {
      'http.request.method': method,
      'server.address': url.hostname,
      'server.port': port,
      'url.full': sanitizeUrl(url),
    };
    const parent = parentContext(base);
    const span = telemetry.tracer.startSpan(`HTTP ${method}`, { kind: SpanKind.CLIENT, attributes }, parent);
    injectHeaders(telemetry, trace.setSpan(parent, span), headers);
    const signals = [options.signal, init.signal ?? undefined, input instanceof Request ? input.signal : undefined].filter(Boolean) as AbortSignal[];
    const started = performance.now();
    const metricAttributes: Attributes = { 'http.request.method': method, 'server.address': url.hostname, 'server.port': port };
    try {
      const response = await context.with(trace.setSpan(parent, span), () =>
        send(input, { ...init, method, headers, ...(signals.length && { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }) }),
      );
      span.setAttribute('http.response.status_code', response.status);
      metricAttributes['http.response.status_code'] = response.status;
      if (response.status >= 400) {
        span.setAttribute('error.type', String(response.status));
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        metricAttributes['error.type'] = String(response.status);
      }
      return response;
    } catch (error) {
      const type = (error as Error)?.name ?? 'Error';
      span.setAttribute('error.type', type);
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: scrub((error as Error)?.message ?? String(error)) });
      metricAttributes['error.type'] = type;
      throw error;
    } finally {
      span.end();
      if (telemetry.enabled) telemetry.instruments.httpClientDuration.record((performance.now() - started) / 1000, metricAttributes);
    }
  };
}
