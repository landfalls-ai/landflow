/**
 * Host span processing: the sampler (standard OTEL_TRACES_SAMPLER plus a noise
 * filter for Next.js request spans) and the processor that tidies attributes,
 * records http.server.request.duration and writes `span.end` log lines. Read-only API requests (GET) are sampled at
 * their end: kept when slow (LANDFLOW_TRACE_SLOW_READ_MS) or failed with a 5xx, dropped otherwise (docs/observability.md §2).
 */
import { SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Link } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { SECRET_KEY, telemetryConfig } from './config';
import { isEnabled, writeRecord } from './logger';
import { recordHttpServerDuration } from './metrics';
import { envNumber } from '../config';

const NEXT_REQUEST = 'BaseServer.handleRequest';
/** Next.js spans worth keeping in a request trace; module loading, page-component lookup and the like are dropped. */
const NEXT_KEPT = new Set([NEXT_REQUEST, 'AppRouteRouteHandlers.runHandler', 'AppRender.fetch', 'Middleware.execute']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Requests that get no trace (docs/observability.md §2): the SSE stream, health
 * checks, plugin announces/heartbeats, metric scrapes, read-only GETs (the UI
 * polls those; webhooks are still traced) and everything that is not an API
 * route (pages, assets, HMR). Their server spans are still recorded but not
 * sampled, so they count in http.server.request.duration. Trigger URLs are
 * traced like webhooks, production and test alike: webhooks with any method,
 * form submissions and MCP Server Trigger requests (POST).
 */
const UNTRACED_PATH = /^\/api\/(events|health|metrics|plugins\/announce)(\/|\?|$)/;
const WEBHOOK_PATH = /^\/api\/webhook(-test)?\//;
const TRIGGER_POST_PATH = /^\/(form|form-test|mcp|mcp-test)\//;

/** Marks the server span of a read-only API request whose export is decided when it ends. */
export const DEFERRED_READ = 'landflow.trace.deferred_read';

/** An API read (not a webhook or a polled path): its trace is kept only when slow or failed. */
export function isDeferredRead(method: string, path: string): boolean {
  return READ_METHODS.has(method) && path.startsWith('/api/') && !UNTRACED_PATH.test(path) && !WEBHOOK_PATH.test(path);
}

export function isTracedRequest(method: string, path: string): boolean {
  if (WEBHOOK_PATH.test(path)) return true;
  if (TRIGGER_POST_PATH.test(path)) return !READ_METHODS.has(method);
  if (!path.startsWith('/api/') || UNTRACED_PATH.test(path)) return false;
  return !READ_METHODS.has(method);
}

export function samplerFromEnv(): Sampler {
  const name = (process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const ratio = envNumber('OTEL_TRACES_SAMPLER_ARG', { fallback: 1, min: 0, max: 1 });
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

export class LandflowSampler implements Sampler {
  constructor(private readonly inner: Sampler) {}

  shouldSample(context: Context, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    const type = attributes['next.span_type'];
    if (type === NEXT_REQUEST && kind === SpanKind.SERVER) {
      const method = String(attributes['http.method'] ?? '');
      const path = String(attributes['http.target'] ?? '').split('?')[0];
      if (!isTracedRequest(method, path)) {
        // A read is sampled like any request so its children are recorded; the processor drops the trace if it was fast.
        if (!isDeferredRead(method, path)) return { decision: SamplingDecision.RECORD };
        const result = this.inner.shouldSample(context, traceId, name, kind, attributes, links);
        return result.decision === SamplingDecision.RECORD_AND_SAMPLED ? { ...result, attributes: { ...result.attributes, [DEFERRED_READ]: true } } : { decision: SamplingDecision.RECORD };
      }
    } else if (type && (!NEXT_KEPT.has(String(type)) || !trace.getSpanContext(context))) {
      // Next.js internals, and Next.js work outside a request (compiling, loading modules).
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.inner.shouldSample(context, traceId, name, kind, attributes, links);
  }

  toString() {
    return `LandflowSampler{${this.inner.toString()}}`;
  }
}

const KIND = ['internal', 'server', 'client', 'producer', 'consumer'];
const isSampled = (span: ReadableSpan) => (span.spanContext().traceFlags & 1) === 1;

/** Spans of a read trace that has not ended yet are held at most this long (a request that never ends must not leak). */
const DEFERRED_TTL_MS = 5 * 60_000;
const DEFERRED_MAX_SPANS = 500;

/**
 * `downstream` are the processors that export (the OTLP batch processor): they hear only of spans that were kept. A read
 * trace's spans are held until its server span ends, then released together when the request was slow or failed, else
 * dropped (metrics and tidying run for every span either way).
 */
export class LandflowSpanProcessor implements SpanProcessor {
  private readonly held = new Map<string, { since: number; spans: ReadableSpan[] }>();
  private lastSweep = 0;

  constructor(
    private readonly downstream: SpanProcessor[] = [],
    private readonly slowMs: number = telemetryConfig.slowReadMs,
  ) {}

  onStart(span: Span, parent: Context): void {
    if (span.attributes[DEFERRED_READ]) {
      this.sweep();
      this.held.set(span.spanContext().traceId, { since: Date.now(), spans: [] });
    }
    for (const processor of this.downstream) processor.onStart(span, parent);
  }

  private sweep() {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [traceId, entry] of this.held) if (now - entry.since > DEFERRED_TTL_MS) this.held.delete(traceId);
  }

  /** Release a span to the exporters and the log, or hold it until its read trace is decided. */
  private route(span: ReadableSpan) {
    const traceId = span.spanContext().traceId;
    const entry = this.held.get(traceId);
    if (!entry) return this.release(span);
    if (span.attributes[DEFERRED_READ]) {
      this.held.delete(traceId);
      const status = Number(span.attributes['http.response.status_code'] ?? 0);
      if (hrTimeToMilliseconds(span.duration) >= this.slowMs || status >= 500 || span.status.code === SpanStatusCode.ERROR) {
        for (const held of entry.spans) this.release(held);
        this.release(span);
      }
    } else if (entry.spans.length < DEFERRED_MAX_SPANS) entry.spans.push(span);
  }

  private release(span: ReadableSpan) {
    this.log(span);
    for (const processor of this.downstream) processor.onEnd(span);
  }

  onEnding(span: Span): void {
    for (const processor of this.downstream) processor.onEnding?.(span);
    const { attributes } = span;
    if (attributes['next.span_type'] === NEXT_REQUEST) {
      // Next.js sets the old HTTP conventions; add the current ones (and never keep the query string).
      const path = String(attributes['http.target'] ?? '').split('?')[0];
      span.setAttributes({
        'http.request.method': String(attributes['http.method'] ?? ''),
        'url.path': path,
        'http.target': path,
        ...(attributes['http.status_code'] !== undefined && { 'http.response.status_code': Number(attributes['http.status_code']) }),
      });
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string' && SECRET_KEY.test(key)) span.setAttribute(key, '[redacted]');
    }
  }

  onEnd(span: ReadableSpan): void {
    const { attributes } = span;
    const isRequest = attributes['next.span_type'] === NEXT_REQUEST;
    if (isRequest) {
      recordHttpServerDuration(hrTimeToMilliseconds(span.duration) / 1000, {
        'http.request.method': attributes['http.request.method'] ?? '',
        ...(attributes['http.route'] !== undefined && { 'http.route': attributes['http.route'] }),
        ...(attributes['http.response.status_code'] !== undefined && { 'http.response.status_code': attributes['http.response.status_code'] }),
      });
    }
    if (isSampled(span)) this.route(span);
  }

  private log(span: ReadableSpan): void {
    const { attributes } = span;
    const isRequest = attributes['next.span_type'] === NEXT_REQUEST;
    if (!telemetryConfig.logSpans) return;
    // Next.js' own internal spans stay in the trace but not in the log.
    if (attributes['next.span_type'] && !isRequest) return;
    const failed = span.status.code === SpanStatusCode.ERROR;
    if (!isEnabled(failed ? 'error' : 'info')) return;
    const ids = span.spanContext();
    const fields = {
      span: span.name,
      kind: KIND[span.kind] ?? 'internal',
      trace_id: ids.traceId,
      span_id: ids.spanId,
      ...(span.parentSpanContext && { parent_span_id: span.parentSpanContext.spanId }),
      duration_ms: Math.round(hrTimeToMilliseconds(span.duration) * 10) / 10,
      status: failed ? 'error' : 'ok',
      ...(failed && { error: span.status.message ?? 'error' }),
      attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith('next.'))),
    };
    writeRecord(failed ? 'error' : 'info', 'span.end', fields, new Date(hrTimeToMilliseconds(span.endTime)));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.downstream.map((processor) => processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.downstream.map((processor) => processor.shutdown()));
  }
}
