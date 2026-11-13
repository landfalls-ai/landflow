/** Span helpers for host code. All of them are no-ops when telemetry is disabled. */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Link, type Span } from '@opentelemetry/api';
import { telemetryConfig } from './config';
import { exceptionFingerprint } from './fingerprint';

export { SpanKind, SpanStatusCode, type Attributes, type Span };

export const hostTracer = () => trace.getTracer('landflow-host', telemetryConfig.serviceVersion);

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Start a new trace (linked to the active span, if any) instead of a child of the active span. */
  root?: boolean;
  /** Parent context (default: the active one). */
  parent?: Context;
}

/** Start a span and return it with the context that has it active. */
export function startSpan(name: string, options: SpanOptions = {}): { span: Span; context: Context } {
  const parent = options.parent ?? context.active();
  const active = trace.getSpanContext(parent);
  const links: Link[] = options.root && active && trace.isSpanContextValid(active) ? [{ context: active }] : [];
  const span = hostTracer().startSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes, root: options.root, links }, parent);
  return { span, context: trace.setSpan(parent, span) };
}

/** Mark a span failed: error status plus an `exception` event. */
export function failSpan(span: Span, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Not recordException(): that takes no attributes, and the event needs the fingerprint that groups the same bug.
  span.addEvent('exception', {
    'exception.type': error instanceof Error ? error.name : 'string',
    'exception.message': message,
    ...(error instanceof Error && error.stack && { 'exception.stacktrace': error.stack }),
    'exception.fingerprint': exceptionFingerprint(error),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Run `fn` inside a new span: it is active for everything `fn` calls, gets an
 * error status if `fn` throws, and always ends.
 */
export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const { span, context: spanContext } = startSpan(name, options);
  try {
    return await context.with(spanContext, () => fn(span));
  } catch (error) {
    failSpan(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** W3C trace context (`traceparent`, `tracestate`, `baggage`) of a context, as headers. */
export function traceHeaders(from: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(from, carrier);
  return carrier;
}

/** `{ traceparent }` for a response, or nothing when there is no trace. */
export function traceparentHeader(from: Context = context.active()): Record<string, string> {
  const { traceparent } = traceHeaders(from);
  return traceparent ? { traceparent } : {};
}

/** Ids of the active span, e.g. to put in an API response. */
export function activeTraceIds(from: Context = context.active()): { traceId: string; spanId: string } | undefined {
  const ids = trace.getSpanContext(from);
  return ids && trace.isSpanContextValid(ids) ? { traceId: ids.traceId, spanId: ids.spanId } : undefined;
}
