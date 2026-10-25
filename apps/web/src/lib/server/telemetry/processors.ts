/**
 * Host span processing: the sampler (standard OTEL_TRACES_SAMPLER plus a noise
 * filter for Next.js request spans) and the processor that tidies attributes,
 * records http.server.request.duration and writes `span.end` log lines.
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

const NEXT_REQUEST = 'BaseServer.handleRequest';
/** Next.js spans worth keeping in a request trace; module loading, page-component lookup and the like are dropped. */
const NEXT_KEPT = new Set([NEXT_REQUEST, 'AppRouteRouteHandlers.runHandler', 'AppRender.fetch', 'Middleware.execute']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Requests that get no trace (docs/observability.md §2): the SSE stream, health
 * checks, plugin announces/heartbeats, metric scrapes, read-only GETs (the UI
 * polls those; webhooks are still traced) and everything that is not an API
 * route (pages, assets, HMR). Their server spans are still recorded but not
 * sampled, so they count in http.server.request.duration.
 */
const UNTRACED_PATH = /^\/api\/(events|health|metrics|plugins\/announce)(\/|\?|$)/;

function isTracedRequest(method: string, path: string): boolean {
  if (!path.startsWith('/api/') || UNTRACED_PATH.test(path)) return false;
  return !READ_METHODS.has(method) || path.startsWith('/api/webhook/');
}

export function samplerFromEnv(): Sampler {
  const name = (process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const arg = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  const ratio = Number.isFinite(arg) ? Math.min(1, Math.max(0, arg)) : 1;
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
      if (!isTracedRequest(String(attributes['http.method'] ?? ''), String(attributes['http.target'] ?? ''))) return { decision: SamplingDecision.RECORD };
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

export class LandflowSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
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
    if (!telemetryConfig.logSpans || !isSampled(span)) return;
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

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
