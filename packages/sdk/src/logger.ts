/**
 * The process log (docs/observability.md §3): one JSON object per line on
 * stdout (or `pretty` lines), each carrying the active span's trace/span ids,
 * with secrets redacted. `SpanLogProcessor` adds one `span.end` line per
 * finished span.
 */
import { context, isSpanContextValid, SpanStatusCode, trace, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';
import { redactAttributes, redactValue, scrub } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';
export type LogAttributes = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'service', 'msg', 'trace_id', 'span_id']);
const SPAN_KINDS = ['internal', 'server', 'client', 'producer', 'consumer'];

export interface ProcessLogger {
  readonly service: string;
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
  log(level: LogLevel, message: string, attributes?: LogAttributes): void;
  enabled(level: LogLevel): boolean;
  /** A logger that adds `attributes` to every line. */
  child(attributes: LogAttributes): ProcessLogger;
  /** Write a pre-built record (used for span.end lines). Redacts like every other line. */
  write(level: LogLevel, message: string, fields: LogAttributes, ids?: { traceId: string; spanId: string }): void;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  format?: LogFormat;
  /** Line sink, default stdout. Tests pass an array push. */
  write?: (line: string) => void;
  /** Drop every line (still honouring the interface). */
  silent?: boolean;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const level = value?.toLowerCase();
  return level && level in LEVELS ? (level as LogLevel) : fallback;
}

function activeIds(): SpanContext | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext : undefined;
}

function toLogValue(key: string, value: unknown): unknown {
  if (value instanceof Error) return scrub(value.message);
  if (typeof value === 'bigint') return value.toString();
  return redactValue(key, value);
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

export function createLogger(options: LoggerOptions, base: LogAttributes = {}): ProcessLogger {
  const threshold = LEVELS[options.level ?? 'info'];
  const format = options.format ?? 'json';
  const sink = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));

  const emit = (level: LogLevel, message: string, fields: LogAttributes, ids?: { traceId: string; spanId: string }) => {
    if (options.silent || LEVELS[level] < threshold) return;
    const now = new Date();
    if (format === 'pretty') {
      if (message === 'span.end') {
        // "span.end plugin.execute demo.echo 7.2ms ok (trace=…/span=…) kind=server …"
        const { span, duration_ms, status, ...rest } = fields;
        message = `span.end ${span} ${duration_ms}ms ${status}`;
        fields = rest;
      }
      const pairs = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${prettyValue(v)}`)
        .join(' ');
      const where = ids ? ` (trace=${ids.traceId}/span=${ids.spanId})` : '';
      sink(`${now.toTimeString().slice(0, 8)} ${level.padEnd(5)} ${options.service} ${scrub(message)}${where}${pairs ? ` ${pairs}` : ''}`);
      return;
    }
    const line: LogAttributes = { ts: now.toISOString(), level, service: options.service, msg: scrub(message) };
    if (ids) {
      line.trace_id = ids.traceId;
      line.span_id = ids.spanId;
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line[RESERVED.has(key) ? `attr.${key}` : key] = value;
    }
    let text: string;
    try {
      text = JSON.stringify(line);
    } catch {
      text = JSON.stringify({ ts: line.ts, level, service: options.service, msg: line.msg, ...(ids && { trace_id: ids.traceId, span_id: ids.spanId }) });
    }
    sink(text);
  };

  const log = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    if (options.silent || LEVELS[level] < threshold) return;
    const fields: LogAttributes = {};
    for (const [key, value] of Object.entries({ ...base, ...attributes })) fields[key] = toLogValue(key, value);
    const spanContext = activeIds();
    emit(level, message, fields, spanContext && { traceId: spanContext.traceId, spanId: spanContext.spanId });
  };

  return {
    service: options.service,
    debug: (m, a) => log('debug', m, a),
    info: (m, a) => log('info', m, a),
    warn: (m, a) => log('warn', m, a),
    error: (m, a) => log('error', m, a),
    log,
    enabled: (level) => !options.silent && LEVELS[level] >= threshold,
    child: (attributes) => createLogger(options, { ...base, ...attributes }),
    write: (level, message, fields, ids) => emit(level, message, redactAttributes(fields), ids),
  };
}

const hrToMs = (time: [number, number]) => time[0] * 1e3 + time[1] / 1e6;

/** `LANDFLOW_LOG_SPANS`: one `span.end` line per finished span. */
export class SpanLogProcessor implements SpanProcessor {
  constructor(private readonly logger: ProcessLogger) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    const failed = span.status.code === SpanStatusCode.ERROR;
    const level: LogLevel = failed ? 'error' : 'info';
    if (!this.logger.enabled(level)) return;
    const { traceId, spanId } = span.spanContext();
    const fields: LogAttributes = {
      span: span.name,
      kind: SPAN_KINDS[span.kind] ?? 'internal',
      ...(span.parentSpanContext && { parent_span_id: span.parentSpanContext.spanId }),
      duration_ms: Math.round(hrToMs(span.duration) * 10) / 10,
      status: failed ? 'error' : 'ok',
      ...(failed && { error: span.status.message ?? 'error' }),
      attributes: redactAttributes({ ...span.attributes }),
    };
    this.logger.write(level, 'span.end', fields, { traceId, spanId });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
